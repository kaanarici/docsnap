import type { Config, FetchResult, RedirectHop } from "../core/types.ts";
import { validatePublicHttpUrl } from "../security/url.ts";
import type { BrowserSession } from "./browser.ts";
import { handlePausedRenderRequest } from "./fulfill.ts";
import type { RenderCandidate, RenderPageOutput } from "./index.ts";
import { RenderPolicy } from "./policy.ts";

export class ChromeRenderer {
	private readonly policy: RenderPolicy;

	constructor(
		private readonly session: BrowserSession,
		config: Config,
	) {
		this.policy = new RenderPolicy(config);
	}

	async render(
		candidate: RenderCandidate,
		config: Config,
	): Promise<RenderPageOutput> {
		const started = performance.now();
		const url = candidate.input.result.finalUrl;
		const mainError = await this.policy.checkMainNavigation(url);
		if (mainError) {
			return failure(started, mainError, this.session.product);
		}
		const timeoutMs = pageTimeoutMs(config);
		const pagePolicy = this.policy.beginPage();
		let targetId = "";
		let sessionId = "";
		const pending = new Set<string>();
		const activity = { at: performance.now() };
		const unsubscribe: Array<() => void> = [];
		try {
			const target = await this.session.cdp.send<{ targetId: string }>(
				"Target.createTarget",
				{ url: "about:blank" },
			);
			targetId = target.targetId;
			const attach = await this.session.cdp.send<{ sessionId: string }>(
				"Target.attachToTarget",
				{ targetId, flatten: true },
			);
			sessionId = attach.sessionId;
			unsubscribe.push(
				this.session.cdp.on("Fetch.requestPaused", async (message) => {
					const params = message.params as FetchPaused;
					if (message.sessionId !== sessionId) return;
					pending.add(params.requestId);
					try {
						await handlePausedRenderRequest(
							params,
							pagePolicy,
							config,
							(method, commandParams) =>
								this.session.cdp.send(method, commandParams, sessionId, 1_000),
						);
					} catch {
						try {
							await this.session.cdp.send(
								"Fetch.failRequest",
								{ requestId: params.requestId, errorReason: "BlockedByClient" },
								sessionId,
								1_000,
							);
						} catch {
							// The target may already be closing; CDP dispatch also swallows this.
						}
					} finally {
						pending.delete(params.requestId);
						activity.at = performance.now();
					}
				}),
				this.session.cdp.on("Network.loadingFinished", (message) => {
					if (message.sessionId !== sessionId) return;
					const id = (message.params as { requestId?: string }).requestId;
					if (id) pending.delete(id);
					activity.at = performance.now();
				}),
				this.session.cdp.on("Network.loadingFailed", (message) => {
					if (message.sessionId !== sessionId) return;
					const id = (message.params as { requestId?: string }).requestId;
					if (id) pending.delete(id);
					activity.at = performance.now();
				}),
			);
			await this.setupPage(sessionId, config, timeoutMs);
			const navigate = await this.session.cdp.send<{ errorText?: string }>(
				"Page.navigate",
				{ url },
				sessionId,
				timeoutMs,
			);
			if (navigate.errorText) throw new Error(navigate.errorText);
			const timedOut = await waitForReady(
				this.session.cdp,
				sessionId,
				pending,
				activity,
				timeoutMs,
			);
			if (!timedOut) await Bun.sleep(500);
			const finalUrl = await evaluateString(
				this.session.cdp,
				sessionId,
				"location.href",
			);
			const body = await evaluateString(
				this.session.cdp,
				sessionId,
				boundedOuterHtmlExpression(config.maxBytes),
			);
			return {
				ok: true,
				browser: this.session.product,
				renderMs: performance.now() - started,
				resourceRequests: pagePolicy.resourceRequests,
				blockedRequests: pagePolicy.blockedRequests,
				...(timedOut ? { timedOut: true } : {}),
				result: renderedFetchResult(candidate.input.result, body, finalUrl),
			};
		} catch (error) {
			return failure(
				started,
				error instanceof Error ? error.message : String(error),
				this.session.product,
				pagePolicy.resourceRequests,
				pagePolicy.blockedRequests,
			);
		} finally {
			for (const off of unsubscribe) off();
			if (targetId) {
				try {
					await this.session.cdp.send("Target.closeTarget", { targetId });
				} catch {
					// The target may already be gone after navigation failures.
				}
			}
		}
	}

	async close() {
		await this.session.close();
	}

	private async setupPage(
		sessionId: string,
		config: Config,
		timeoutMs: number,
	) {
		await this.session.cdp.send("Page.enable", {}, sessionId, timeoutMs);
		await this.session.cdp.send("Runtime.enable", {}, sessionId, timeoutMs);
		await this.session.cdp.send("Network.enable", {}, sessionId, timeoutMs);
		await this.session.cdp.send(
			"Network.setUserAgentOverride",
			{ userAgent: config.userAgent },
			sessionId,
			timeoutMs,
		);
		await this.session.cdp.send(
			"Network.setBypassServiceWorker",
			{ bypass: true },
			sessionId,
			timeoutMs,
		);
		await this.session.cdp.send(
			"Fetch.enable",
			{ patterns: [{ urlPattern: "*", requestStage: "Request" }] },
			sessionId,
			timeoutMs,
		);
	}
}

type FetchPaused = {
	requestId: string;
	networkId?: string;
	resourceType?: string;
	isNavigationRequest?: boolean;
	request: {
		url: string;
		method?: string;
		headers?: Record<string, string>;
	};
};

async function waitForReady(
	cdp: BrowserSession["cdp"],
	sessionId: string,
	pending: Set<string>,
	activity: { at: number },
	timeoutMs: number,
) {
	const deadline = performance.now() + timeoutMs;
	while (performance.now() < deadline) {
		const readyState = await evaluateString(
			cdp,
			sessionId,
			"document.readyState",
			1_000,
		).catch(() => "");
		if (
			/^(interactive|complete)$/.test(readyState) &&
			pending.size === 0 &&
			performance.now() - activity.at >= 1_000
		) {
			return false;
		}
		await Bun.sleep(100);
	}
	return true;
}

async function evaluateString(
	cdp: BrowserSession["cdp"],
	sessionId: string,
	expression: string,
	timeoutMs = 2_000,
) {
	const out = await cdp.send<{
		result?: { value?: string };
	}>(
		"Runtime.evaluate",
		{ expression, returnByValue: true },
		sessionId,
		timeoutMs,
	);
	return capUtf8(out.result?.value ?? "", expressionMaxBytes(expression));
}

export function boundedOuterHtmlExpression(maxBytes: number) {
	return `document.documentElement ? document.documentElement.outerHTML.slice(0, ${safeMaxBytes(maxBytes)}) : ""`;
}

export function capUtf8(value: string, maxBytes: number) {
	if (!Number.isFinite(maxBytes)) return value;
	const limit = safeMaxBytes(maxBytes);
	const encoded = new TextEncoder().encode(value);
	if (encoded.byteLength <= limit) return value;
	return new TextDecoder().decode(encoded.subarray(0, limit));
}

function expressionMaxBytes(expression: string) {
	const match = expression.match(/\.slice\(0,\s*(\d+)\)/);
	return match ? Number(match[1]) : Number.POSITIVE_INFINITY;
}

function safeMaxBytes(value: number) {
	return Math.max(0, Math.floor(Number.isFinite(value) ? value : 0));
}

function renderedFetchResult(
	original: FetchResult,
	body: string,
	finalUrl: string,
): FetchResult {
	const cleanFinalUrl = cleanHttpUrl(finalUrl) ?? original.finalUrl;
	return {
		url: original.url,
		finalUrl: cleanFinalUrl,
		status: 200,
		contentType: "text/html; charset=utf-8",
		body,
		fetchMs: original.fetchMs,
		redirects: renderedRedirects(original, cleanFinalUrl),
		fetchedAt: new Date().toISOString(),
		ok: true,
	};
}

function renderedRedirects(
	original: FetchResult,
	finalUrl: string,
): RedirectHop[] {
	const redirects = [...(original.redirects ?? [])];
	if (original.finalUrl !== finalUrl) {
		redirects.push({
			from: original.finalUrl,
			to: finalUrl,
			type: "http",
		});
	}
	return redirects;
}

function cleanHttpUrl(raw: string): string | undefined {
	try {
		const url = new URL(raw);
		url.username = "";
		url.password = "";
		url.hash = "";
		const value = url.href;
		return validatePublicHttpUrl(value) ? undefined : value;
	} catch {
		return undefined;
	}
}

function failure(
	started: number,
	error: string,
	browser: string,
	resourceRequests = 0,
	blockedRequests = 0,
): RenderPageOutput {
	return {
		ok: false,
		browser,
		error,
		renderMs: performance.now() - started,
		resourceRequests,
		blockedRequests,
	};
}

function pageTimeoutMs(config: Config) {
	return Math.min(20_000, Math.max(8_000, config.timeoutMs * 2));
}
