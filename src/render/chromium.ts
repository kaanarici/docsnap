import { maxGeneratedMediaUrls } from "../core/config.ts";
import { artifactUrl } from "../core/identity.ts";
import {
	isJsonBoolean,
	isJsonNumber,
	isJsonObject,
	isJsonString,
	type JsonValue,
} from "../core/json.ts";
import { awaitWithSignal } from "../core/parallel.ts";
import type {
	FailureKind,
	FetchResult,
	HeaderMap,
	PipelineConfig,
} from "../core/types.ts";
import { loadRobots, maxRobotsBytes, type Robots } from "../discover/robots.ts";
import { declaredCharset } from "../fetch/body.ts";
import { responseHeadersFor } from "../fetch/fetcher.ts";
import { requestPublicHttp } from "../fetch/transport.ts";
import { validatePublicHttpUrl } from "../security/url.ts";
import {
	Cdp,
	type CdpClient,
	type CdpEvent,
	chromeExists,
	chromePath,
	type JsonObject,
} from "./cdp.ts";
import {
	blockerSource,
	renderedPageExpression,
	shellStateExpression,
} from "./page.ts";

const words = (input: string) => new Set(input.split(" "));
const allowedTypes = words("Document Script Worker XHR Fetch Stylesheet");
const mediaTypes = new Set(["Image", "Media"]);
const fetchPatterns = ["http://*", "https://*"].map((urlPattern) => ({
	urlPattern,
	requestStage: "Request",
}));
const blockedRequestHeaders = words(
	"accept-encoding authorization connection content-length host proxy-authorization proxy-connection transfer-encoding upgrade x-http-method x-http-method-override x-method-override",
);
const blockedResponseHeaders = words(
	"connection content-encoding content-length keep-alive proxy-authenticate proxy-authorization trailer transfer-encoding upgrade",
);
const maxAggregateBytes = 24 * 1024 * 1024;
const maxInterceptedRequests = 256;
const maxRelayedRequests = 64;
const maxRelayOrigins = 32;
const maxAggregateRobotsRules = 20_000;
const sensitivePath =
	/\/(?:captcha|checkout|log-in|login|paywall|register|sign-in|sign-up|signin|signup)(?:\/|$)/i;

export type ChromiumRenderMetrics = {
	launchMs: number;
	renderMs: number;
	blockedRequests: number;
	fulfilledRequests: number;
	relayedBytes: number;
	mediaUrls: string[];
	truncated: boolean;
};

export type ChromiumRenderResult =
	| { ok: true; result: FetchResult; metrics: ChromiumRenderMetrics }
	| {
			ok: false;
			kind: "timeout" | "render";
			error: string;
			metrics: ChromiumRenderMetrics;
	  };

type ChromiumOpenResult =
	| { ok: true; renderer: ChromiumRenderer }
	| { ok: false; error: string; launchMs: number };
type Run = {
	shell: FetchResult;
	shellFulfillment?: { contentType?: string };
	signal: AbortSignal;
	media: Set<string>;
	origins: Set<string>;
	byteWaiters: Array<() => void>;
	robots: Map<string, Promise<Robots | undefined>>;
	scriptRequests: Set<string>;
	blocked: number;
	fulfilled: number;
	inflight: number;
	intercepted: number;
	requests: number;
	relayedBytes: number;
	reservedBytes: number;
	robotRules: number;
	truncated: boolean;
	document?: { url: string; status: number; contentType: string };
};

export async function openChromiumRenderer(
	config: PipelineConfig,
): Promise<ChromiumOpenResult> {
	const started = performance.now();
	if (!chromeExists())
		return {
			ok: false,
			error: `Chrome is not installed at ${chromePath}`,
			launchMs: performance.now() - started,
		};
	let cdp: Cdp | undefined;
	try {
		cdp = new Cdp(chromePath);
		await cdp.start();
		return { ok: true, renderer: new ChromiumRenderer(cdp, config) };
	} catch (error) {
		await cdp?.close().catch(() => undefined);
		return {
			ok: false,
			error: message(error),
			launchMs: performance.now() - started,
		};
	}
}
export class ChromiumRenderer {
	private contextId: string | undefined;
	private sessionId: string | undefined;
	private run: Run | undefined;
	private closed = false;
	private active = 0;
	private readonly waiters: Array<() => void> = [];
	private readonly signalHandlers = new Map<"SIGINT" | "SIGTERM", () => void>();

	constructor(
		private readonly cdp: CdpClient,
		private readonly config: PipelineConfig,
	) {
		cdp.onEvent = (event) => this.onEvent(event);
		for (const signal of ["SIGINT", "SIGTERM"] as const) {
			const handler = () => {
				void this.close().finally(() => process.kill(process.pid, signal));
			};
			this.signalHandlers.set(signal, handler);
			process.once(signal, handler);
		}
	}

	async renderPage(
		shell: FetchResult,
		options: { signal?: AbortSignal; explicitSeed?: boolean } = {},
	): Promise<ChromiumRenderResult> {
		const started = performance.now();
		if (this.closed)
			return this.failure("render", "Renderer is closed", started);
		if (this.run) return this.failure("render", "Renderer is busy", started);
		if (!shell.ok || shell.notModified || !shell.body) {
			return this.failure("render", "Fetched HTML required", started);
		}
		const startUrl = shell.redirects?.length ? shell.url : shell.finalUrl;
		const unsafe =
			validatePublicHttpUrl(shell.finalUrl) ?? validatePublicHttpUrl(startUrl);
		if (unsafe)
			return this.failure("render", `Unsafe render URL: ${unsafe}`, started);

		const controller = new AbortController();
		const timeout = AbortSignal.timeout(this.config.timeoutMs);
		const signals = [controller.signal, timeout];
		if (options.signal) signals.push(options.signal);
		const fulfillment = responseHeadersFor(shell) && shellFulfillment(shell);
		const run: Run = {
			shell,
			signal: AbortSignal.any(signals),
			blocked: 0,
			fulfilled: 0,
			inflight: 0,
			intercepted: 0,
			media: new Set(),
			origins: new Set(),
			byteWaiters: [],
			robots: new Map(),
			scriptRequests: new Set(),
			requests: 0,
			relayedBytes: 0,
			reservedBytes: 0,
			robotRules: 0,
			truncated: false,
		};
		if (fulfillment) run.shellFulfillment = fulfillment;
		this.run = run;
		try {
			await this.ensureContext(run.signal);
			await this.cdp.send(
				"Page.navigate",
				{ url: startUrl },
				this.sessionId,
				run.signal,
			);
			await this.settle(run);
			const page = renderedPageValue(
				await this.evaluate(
					renderedPageExpression(this.config.maxBytes),
					run.signal,
				),
			);
			if (page?.[3]) throw new Error(`Rendered page exceeds ${page[3]}`);
			if (page && page[2] > this.config.maxBytes) {
				throw new Error(`Rendered page exceeds ${this.config.maxBytes} bytes`);
			}
			if (!page?.[0]) throw new Error("Rendered page was empty");
			const finalUrl = artifactUrl(page[1]);
			if (!finalUrl || validatePublicHttpUrl(finalUrl))
				throw new Error("Rendered page ended at an unsafe URL");
			if (!options.explicitSeed) {
				const robots = await this.robotsFor(run, new URL(finalUrl).origin);
				if (!robots?.allowed(finalUrl))
					throw new Error("Rendered page ended at a robots-disallowed URL");
			}
			const document =
				run.document && artifactUrl(run.document.url) === finalUrl
					? run.document
					: shell;
			const redirects = [...(shell.redirects ?? [])];
			const from = artifactUrl(shell.finalUrl);
			if (from && from !== finalUrl) {
				redirects.push({ from, to: finalUrl, type: "client" });
			}
			const rendered = {
				...shell,
				finalUrl,
				body: page[0],
				status: document.status,
				contentType: document.contentType,
				redirects,
			};
			const result: FetchResult =
				document.status >= 200 && document.status <= 299
					? rendered
					: {
							...rendered,
							ok: false,
							error: `HTTP ${document.status}`,
							failureKind: httpDocumentKind(document.status),
						};
			return {
				ok: true,
				result,
				metrics: this.metrics(performance.now() - started, run),
			};
		} catch (error) {
			const timeout = run.signal.aborted;
			return this.failure(
				timeout ? "timeout" : "render",
				timeout ? "Chromium render timed out" : message(error),
				started,
				run,
			);
		} finally {
			controller.abort();
			const disposed = await this.disposeContext();
			for (let waits = 0; run.inflight > 0 && waits < 10; waits++)
				await Bun.sleep(50);
			if (!disposed) await this.close();
			if (this.run === run) this.run = undefined;
		}
	}

	async close() {
		if (this.closed) return;
		this.closed = true;
		for (const [signal, handler] of this.signalHandlers)
			process.off(signal, handler);
		this.signalHandlers.clear();
		this.cdp.onEvent = undefined;
		await this.disposeContext();
		await this.cdp.close();
	}

	private async onEvent(event: CdpEvent) {
		if (event.method === "Target.attachedToTarget") {
			await this.configureAttachedTarget(event);
			return;
		}
		if (event.method === "Network.requestWillBeSent") {
			if (event.params["type"] === "Script")
				this.run?.scriptRequests.add(
					requestKey(event.sessionId, String(event.params["requestId"])),
				);
			return;
		}
		if (event.method !== "Fetch.requestPaused") return;
		const run = this.run;
		const requestId = String(event.params["requestId"]);
		if (!run) {
			await this.block(requestId, event.sessionId).catch(() => undefined);
			return;
		}
		const request = pausedRequest(event.params["request"]);
		if (!request) {
			await this.block(requestId, event.sessionId, run.signal).catch(
				() => undefined,
			);
			return;
		}
		const type = String(event.params["resourceType"] ?? "Other");
		const workerScript = run.scriptRequests.delete(
			requestKey(event.sessionId, String(event.params["networkId"] ?? "")),
		);
		run.intercepted++;
		run.inflight++;
		try {
			if (mediaTypes.has(type)) this.addMedia(run, request.url);
			if (
				run.shellFulfillment &&
				event.sessionId === this.sessionId &&
				type === "Document" &&
				request.method === "GET" &&
				request.url === run.shell.finalUrl
			) {
				const { contentType } = run.shellFulfillment;
				delete run.shellFulfillment;
				const headers = responseHeadersFor(run.shell)!;
				run.document = {
					url: request.url,
					status: run.shell.status,
					contentType: run.shell.contentType,
				};
				await this.cdp.send(
					"Fetch.fulfillRequest",
					{
						requestId,
						responseCode: run.shell.status,
						responseHeaders: responseHeaderList(headers, contentType),
						body: Buffer.from(run.shell.body).toString("base64"),
					},
					event.sessionId,
					run.signal,
				);
				run.fulfilled++;
				return;
			}
			const parsed = URL.parse(request.url);
			if (
				run.intercepted > maxInterceptedRequests ||
				request.method !== "GET" ||
				(!allowedTypes.has(type) && !(type === "Other" && workerScript)) ||
				!parsed ||
				validatePublicHttpUrl(request.url) ||
				sensitivePath.test(parsed.pathname)
			) {
				if (run.intercepted > maxInterceptedRequests) run.truncated = true;
				run.blocked++;
				return void (await this.block(requestId, event.sessionId, run.signal));
			}
			const headers = requestHeaders(request.headers, this.config.userAgent);
			const response = await this.limited(run.signal, async () => {
				if (!this.reserveRelay(run, parsed.origin)) return;
				const robots = await this.robotsFor(run, parsed.origin);
				if (!robots?.allowed(request.url)) return;
				const reserved = await this.reserveBytes(run);
				if (!reserved) return;
				try {
					const response = await requestPublicHttp(
						request.url,
						headers,
						this.config,
						{
							signal: run.signal,
							maxBytes: reserved,
						},
					);
					run.relayedBytes += response.body.byteLength;
					return response;
				} catch (error) {
					run.relayedBytes += reserved;
					if (message(error).includes("response exceeds")) run.truncated = true;
					if (
						run.relayedBytes >=
						Math.min(this.config.maxBytes * 2, maxAggregateBytes)
					) {
						run.truncated = true;
					}
					throw error;
				} finally {
					run.reservedBytes -= reserved;
					for (const resolve of run.byteWaiters.splice(0)) resolve();
				}
			});
			if (
				!response ||
				response.headers
					.get("content-disposition")
					?.toLowerCase()
					.includes("attachment")
			) {
				run.blocked++;
				return void (await this.block(requestId, event.sessionId, run.signal));
			}
			if (
				event.sessionId === this.sessionId &&
				type === "Document" &&
				(response.status < 300 || response.status > 399)
			) {
				run.document = {
					url: request.url,
					status: response.status,
					contentType:
						response.headers.get("content-type") ?? run.shell.contentType,
				};
			}
			await this.cdp.send(
				"Fetch.fulfillRequest",
				{
					requestId,
					responseCode: response.status,
					responseHeaders: responseHeaderList(response.headers),
					body: Buffer.from(response.body).toString("base64"),
				},
				event.sessionId,
				run.signal,
			);
			run.fulfilled++;
		} catch {
			run.blocked++;
			await this.block(requestId, event.sessionId, run.signal).catch(
				() => undefined,
			);
		} finally {
			run.inflight--;
		}
	}

	private async configureAttachedTarget(event: CdpEvent) {
		const run = this.run;
		const sessionId = String(event.params["sessionId"] ?? "");
		const targetInfo = event.params["targetInfo"];
		const target = isJsonObject(targetInfo) ? targetInfo : undefined;
		const targetId = String(target?.["targetId"] ?? "");
		const type = String(target?.["type"] ?? "other");
		const closeTarget = () =>
			targetId
				? this.cdp
						.send(
							"Target.closeTarget",
							{ targetId },
							undefined,
							AbortSignal.timeout(1_000),
						)
						.catch(() => undefined)
				: undefined;
		if (!run || !sessionId) {
			await closeTarget();
			return;
		}
		try {
			await this.configureTarget(sessionId, type, run.signal, true);
		} catch {
			run.blocked++;
			run.truncated = true;
			await closeTarget();
		}
	}

	private async configureTarget(
		sessionId: string,
		type: string,
		signal: AbortSignal,
		resume = false,
	) {
		const send = (method: string, params: JsonObject = {}) =>
			this.cdp.send(method, params, sessionId, signal);
		const pageTarget = type === "page" || type === "iframe";
		await Promise.all([
			send("Network.enable"),
			send("Network.setBlockedURLs", {
				urls: [
					"ws://*",
					"wss://*",
					"file://*",
					"ftp://*",
					...(pageTarget ? [] : ["http://*", "https://*"]),
				],
			}),
			send("Network.setBypassServiceWorker", { bypass: true }),
			send("Network.setUserAgentOverride", {
				userAgent: this.config.userAgent,
			}),
			send("Target.setAutoAttach", {
				autoAttach: true,
				waitForDebuggerOnStart: true,
				flatten: true,
			}),
			...(pageTarget
				? [
						send("Fetch.enable", { patterns: fetchPatterns }),
						send("Page.enable"),
						send("Page.addScriptToEvaluateOnNewDocument", {
							source: blockerSource,
						}),
					]
				: [
						send("Runtime.enable"),
						send("Runtime.evaluate", { expression: blockerSource }),
					]),
		]);
		if (resume) await send("Runtime.runIfWaitingForDebugger");
	}

	private async limited<T>(
		signal: AbortSignal,
		task: () => Promise<T>,
	): Promise<T> {
		while (this.active >= Math.min(this.config.concurrency, 4)) {
			await awaitWithSignal(
				new Promise<void>((resolve) => this.waiters.push(resolve)),
				signal,
			);
		}
		this.active++;
		try {
			return await task();
		} finally {
			this.active--;
			for (const resolve of this.waiters.splice(0)) resolve();
		}
	}

	private reserveRelay(run: Run, origin: string) {
		if (
			run.requests >= maxRelayedRequests ||
			(!run.origins.has(origin) && run.origins.size >= maxRelayOrigins)
		) {
			run.truncated = true;
			return false;
		}
		run.origins.add(origin);
		run.requests++;
		return true;
	}

	private robotsFor(run: Run, origin: string) {
		const existing = run.robots.get(origin);
		if (existing) return existing;
		const pending = this.loadRunRobots(run, origin);
		run.robots.set(origin, pending);
		return pending;
	}

	private async loadRunRobots(
		run: Run,
		origin: string,
	): Promise<Robots | undefined> {
		if (run.robotRules >= maxAggregateRobotsRules) {
			run.truncated = true;
			return;
		}
		const reserved = Math.min(this.config.maxBytes, maxRobotsBytes);
		const cap = Math.min(this.config.maxBytes * 2, maxAggregateBytes);
		if (cap - run.relayedBytes - run.reservedBytes < reserved) {
			run.truncated = true;
			return;
		}
		run.reservedBytes += reserved;
		try {
			const robots = await loadRobots(origin, this.config, run.signal);
			const rules = robots.allows.length + robots.disallows.length;
			if (run.robotRules + rules > maxAggregateRobotsRules) {
				run.truncated = true;
				return;
			}
			run.robotRules += rules;
			return robots;
		} finally {
			run.reservedBytes -= reserved;
			// Failed/oversized robots responses may have consumed the whole allowance
			// even when no body is returned to the parser, so charge the reservation.
			run.relayedBytes += reserved;
			for (const resolve of run.byteWaiters.splice(0)) resolve();
		}
	}

	private async reserveBytes(run: Run) {
		const cap = Math.min(this.config.maxBytes * 2, maxAggregateBytes);
		while (!run.signal.aborted) {
			const remaining = cap - run.relayedBytes - run.reservedBytes;
			if (remaining >= this.config.maxBytes || run.reservedBytes === 0) {
				if (remaining < 1) {
					run.truncated = true;
					return 0;
				}
				const reserved = Math.min(this.config.maxBytes, remaining);
				run.reservedBytes += reserved;
				return reserved;
			}
			await awaitWithSignal(
				new Promise<void>((resolve) => run.byteWaiters.push(resolve)),
				run.signal,
			);
		}
		return 0;
	}

	private block(requestId: string, sessionId?: string, signal?: AbortSignal) {
		return this.cdp.send(
			"Fetch.failRequest",
			{ requestId, errorReason: "BlockedByClient" },
			sessionId,
			signal,
		);
	}

	private async ensureContext(signal: AbortSignal) {
		const send = (method: string, params: JsonObject) =>
			this.cdp.send(method, params, undefined, signal);
		this.contextId = cdpId(
			await send("Target.createBrowserContext", { disposeOnDetach: true }),
			"browserContextId",
			"browser context",
		);
		const targetId = cdpId(
			await send("Target.createTarget", {
				url: "about:blank",
				browserContextId: this.contextId,
			}),
			"targetId",
			"target",
		);
		this.sessionId = cdpId(
			await send("Target.attachToTarget", { targetId, flatten: true }),
			"sessionId",
			"session",
		);
		await this.configureTarget(this.sessionId, "page", signal);
		await send("Browser.setDownloadBehavior", {
			behavior: "deny",
			browserContextId: this.contextId,
		});
	}

	private async disposeContext() {
		const contextId = this.contextId;
		this.contextId = undefined;
		this.sessionId = undefined;
		if (!contextId) return true;
		try {
			await this.cdp.send(
				"Target.disposeBrowserContext",
				{ browserContextId: contextId },
				undefined,
				AbortSignal.timeout(1_000),
			);
			return true;
		} catch {
			return false;
		}
	}

	private async settle(run: Run) {
		const started = performance.now();
		const budget = Math.min(4_000, this.config.timeoutMs);
		let stableSince = started;
		let fingerprint = -1;
		let advanced = false;
		let substantiveSince = 0;
		while (!run.signal.aborted) {
			const state = shellStateValue(
				await this.evaluate(shellStateExpression, run.signal),
			);
			const [
				ready,
				textLength,
				meaningful,
				loading,
				contentFingerprint,
				pendingFrames,
			] = state ?? [false, 0, 0, true, 0, 0];
			const now = performance.now();
			if (contentFingerprint !== fingerprint) {
				fingerprint = contentFingerprint;
				stableSince = now;
			}
			const substantive =
				textLength >= 80 && (meaningful > 0 || textLength >= 500);
			const captureReady =
				ready &&
				!loading &&
				substantive &&
				(pendingFrames === 0 || now - started >= 1_000);
			if (captureReady) substantiveSince ||= now;
			else substantiveSince = 0;
			if (ready && !advanced && run.inflight === 0) {
				advanced = true;
				await this.cdp.send(
					"Emulation.setVirtualTimePolicy",
					{
						policy: "pauseIfNetworkFetchesPending",
						budget: 3_000,
						maxVirtualTimeTaskStarvationCount: 100,
					},
					this.sessionId,
					run.signal,
				);
				continue;
			}
			if (
				captureReady &&
				now - stableSince >= 750 &&
				((advanced && run.inflight === 0) || now - substantiveSince >= 3_000)
			) {
				if (run.inflight > 0 || pendingFrames > 0) run.truncated = true;
				return;
			}
			if (now - started >= budget && run.inflight === 0) {
				run.truncated = true;
				throw new Error("Rendered page remained an app shell");
			}
			await Bun.sleep(50);
		}
		throw run.signal.reason;
	}

	private async evaluate(
		expression: string,
		signal: AbortSignal,
	): Promise<JsonValue | undefined> {
		const response = await this.cdp.send(
			"Runtime.evaluate",
			{ expression, returnByValue: true },
			this.sessionId,
			signal,
		);
		const result = response["result"];
		return isJsonObject(result) ? result["value"] : undefined;
	}

	private addMedia(run: Run, raw: string) {
		const url = artifactUrl(raw);
		if (!url || validatePublicHttpUrl(url) || run.media.has(url)) return;
		if (run.media.size >= maxGeneratedMediaUrls) {
			run.truncated = true;
			return;
		}
		run.media.add(url);
	}

	private failure(
		kind: "timeout" | "render",
		error: string,
		started: number,
		run = this.run,
	): ChromiumRenderResult {
		return {
			ok: false,
			kind,
			error,
			metrics: this.metrics(performance.now() - started, run),
		};
	}

	private metrics(renderMs: number, run = this.run): ChromiumRenderMetrics {
		return {
			launchMs: this.cdp.launchMs,
			renderMs,
			blockedRequests: run?.blocked ?? 0,
			fulfilledRequests: run?.fulfilled ?? 0,
			relayedBytes: run?.relayedBytes ?? 0,
			mediaUrls: [...(run?.media ?? [])],
			truncated: run?.truncated ?? false,
		};
	}
}

type PausedRequest = {
	url: string;
	method: string;
	headers: Record<string, string>;
};

type RenderedPageValue = [string, string, number, string];
type ShellStateValue = [boolean, number, number, boolean, number, number];

function pausedRequest(
	value: JsonValue | undefined,
): PausedRequest | undefined {
	if (
		!isJsonObject(value) ||
		!isJsonString(value["url"]) ||
		!isJsonString(value["method"]) ||
		!isJsonObject(value["headers"])
	) {
		return undefined;
	}
	const headers: Record<string, string> = {};
	for (const [name, item] of Object.entries(value["headers"])) {
		if (!isJsonString(item)) return undefined;
		headers[name] = item;
	}
	return { url: value["url"], method: value["method"], headers };
}

function renderedPageValue(
	value: JsonValue | undefined,
): RenderedPageValue | undefined {
	if (
		!Array.isArray(value) ||
		!isJsonString(value[0]) ||
		!isJsonString(value[1]) ||
		!isJsonNumber(value[2]) ||
		!isJsonString(value[3])
	) {
		return undefined;
	}
	return [value[0], value[1], value[2], value[3]];
}

function shellStateValue(
	value: JsonValue | undefined,
): ShellStateValue | undefined {
	if (
		!Array.isArray(value) ||
		!isJsonBoolean(value[0]) ||
		!isJsonNumber(value[1]) ||
		!isJsonNumber(value[2]) ||
		!isJsonBoolean(value[3]) ||
		!isJsonNumber(value[4]) ||
		!isJsonNumber(value[5])
	) {
		return undefined;
	}
	return [value[0], value[1], value[2], value[3], value[4], value[5]];
}

function requestHeaders(headers: Record<string, string>, userAgent: string) {
	const output: Record<string, string> = {};
	for (const [name, value] of Object.entries(headers)) {
		const normalized = name.toLowerCase();
		if (!blockedRequestHeaders.has(normalized)) output[normalized] = value;
	}
	output["user-agent"] = userAgent;
	output["accept"] ??= "*/*";
	return output;
}

function responseHeaderList(headers: HeaderMap, contentType?: string) {
	const output = [...headers.entries()].flatMap(([name, original]) => {
		const normalized = name.toLowerCase();
		if (blockedResponseHeaders.has(normalized) || normalized === "set-cookie")
			return [];
		const value =
			normalized === "content-type" && contentType ? contentType : original;
		return value ? [{ name: normalized, value }] : [];
	});
	if (contentType && !output.some(({ name }) => name === "content-type")) {
		output.push({ name: "content-type", value: contentType });
	}
	for (const value of headers.getSetCookie?.() ?? []) {
		output.push({ name: "set-cookie", value });
	}
	return output;
}

function shellFulfillment(
	shell: FetchResult,
): { contentType?: string } | undefined {
	const charset = declaredCharset(shell.contentType, shell.body.slice(0, 4096));
	if (charset)
		return ["utf-8", "utf8", "us-ascii"].includes(charset) ? {} : undefined;
	if (shell.body.includes("\uFFFD")) return;
	const contentType = shell.contentType.split(";")[0]?.trim() || "text/html";
	return { contentType: `${contentType}; charset=utf-8` };
}

function httpDocumentKind(status: number): FailureKind {
	if (status === 404 || status === 410) return "not_found";
	if (status === 401 || status === 403 || status === 429) return "blocked";
	return status > 0 ? "http" : "fetch";
}

function requestKey(sessionId: string | undefined, requestId: string) {
	return `${sessionId ?? ""}\0${requestId}`;
}

function cdpId(response: JsonObject, key: string, label: string) {
	const id = response[key];
	if (!isJsonString(id)) throw new Error(`CDP omitted ${label} ID`);
	return id;
}

function message(cause: unknown) {
	return cause instanceof Error ? cause.message : String(cause);
}
