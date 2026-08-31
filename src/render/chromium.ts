import { artifactUrl } from "../core/identity.ts";
import {
	isJsonBoolean,
	isJsonNumber,
	isJsonObject,
	isJsonString,
	type JsonObject,
	type JsonValue,
} from "../core/json.ts";
import { awaitWithSignal } from "../core/parallel.ts";
import type { FetchResult, HeaderMap, PipelineConfig } from "../core/types.ts";
import { loadRobots, maxRobotsBytes, type Robots } from "../discover/robots.ts";
import { declaredCharset } from "../fetch/body.ts";
import { responseHeadersFor } from "../fetch/fetcher.ts";
import { failureKind } from "../fetch/result.ts";
import { requestPublicHttp } from "../fetch/transport.ts";
import { validatePublicHttpUrl } from "../security/url.ts";
import {
	blockerSource,
	renderedPageExpression,
	shellStateExpression,
} from "./page.ts";

export type BrowserView = {
	navigate(url: string): Promise<void>;
	cdp(method: string, params?: JsonObject): Promise<JsonObject>;
	evaluate(script: string): Promise<JsonValue | undefined>;
	addEventListener(
		type: `${string}.${string}`,
		listener: (event: { data: JsonObject }) => void,
	): void;
	close(): void;
};

const chromeFlags = (
	"--host-resolver-rules=MAP * ~NOTFOUND\0--no-first-run\0--no-default-browser-check\0" +
	"--disable-background-networking\0--disable-component-update\0--disable-default-apps\0--disable-extensions\0--disable-sync\0--disable-quic\0--disable-breakpad\0" +
	"--disable-features=ServiceWorker,SharedWorker,MediaRouter,OptimizationHints,Translate,Prerender2\0--metrics-recording-only\0--mute-audio\0--hide-scrollbars"
).split("\0");

const words = (input: string) => new Set(input.split(" "));
const allowedTypes = words("Document Script Worker XHR Fetch Stylesheet");
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
	renderMs: number;
	truncated: boolean;
};

export type ChromiumRenderResult =
	| {
			ok: true;
			result: FetchResult;
			metrics: ChromiumRenderMetrics;
	  }
	| {
			ok: false;
			kind: "timeout" | "render";
			error: string;
			metrics: ChromiumRenderMetrics;
	  };

type ChromiumOpenResult =
	| { ok: true; renderer: ChromiumRenderer }
	| { ok: false; error: string };
type Run = {
	shell: FetchResult;
	shellFulfillment?: { contentType?: string };
	signal: AbortSignal;
	origins: Set<string>;
	byteWaiters: Array<() => void>;
	robots: Map<string, Promise<Robots | undefined>>;
	scriptRequests: Set<string>;
	inflight: number;
	intercepted: number;
	requests: number;
	relayedBytes: number;
	reservedBytes: number;
	robotRules: number;
	truncated: boolean;
	frameId?: string;
	document?: { url: string; status: number; contentType: string };
};

export async function openChromiumRenderer(
	config: PipelineConfig,
): Promise<ChromiumOpenResult> {
	let view: Bun.WebView | undefined;
	let renderer: ChromiumRenderer | undefined;
	try {
		const path = process.env["DOCSNAP_CHROME_PATH"];
		view = new Bun.WebView({
			backend: path
				? { type: "chrome", url: false, path, argv: chromeFlags }
				: { type: "chrome", url: false, argv: chromeFlags },
			dataStore: "ephemeral",
		});
		await view.navigate("about:blank");
		const current = view;
		const browser: BrowserView = {
			navigate: (url) => current.navigate(url),
			cdp: (method, params) => current.cdp<JsonObject>(method, params),
			evaluate: (script) => current.evaluate<JsonValue | undefined>(script),
			addEventListener: (type, listener) =>
				current.addEventListener(String(type), (event) => {
					const data = "data" in event ? event.data : undefined;
					if (data && typeof data === "object" && !Array.isArray(data))
						listener({ data: data as JsonObject });
				}),
			close: () => current.close(),
		};
		renderer = new ChromiumRenderer(browser, config);
		await renderer.start();
		return { ok: true, renderer };
	} catch (error) {
		if (renderer) await renderer.close();
		else view?.close();
		return {
			ok: false,
			error: message(error),
		};
	}
}
export class ChromiumRenderer {
	private run: Run | undefined;
	private closed = false;
	private ready: Promise<void> | undefined;
	private readonly dirtyOrigins = new Set<string>();
	private active = 0;
	private readonly waiters: Array<() => void> = [];
	private cdpQueue: Promise<void> = Promise.resolve();
	private evaluationQueue: Promise<void> = Promise.resolve();
	constructor(
		private readonly view: BrowserView,
		private readonly config: PipelineConfig,
	) {
		view.addEventListener("Network.requestWillBeSent", (event) =>
			this.onRequest(event.data),
		);
		view.addEventListener("Fetch.requestPaused", (event) => {
			void this.onPaused(event.data);
		});
	}

	start() {
		if (!this.ready) this.ready = this.configure();
		return this.ready;
	}

	async renderPage(
		shell: FetchResult,
		options: {
			signal?: AbortSignal;
			explicitSeed?: boolean;
		} = {},
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
			inflight: 0,
			intercepted: 0,
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
			await this.prepare(run.signal);
			await awaitWithSignal(this.view.navigate(startUrl), run.signal);
			await this.settle(run, true);
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
							failureKind: failureKind(document.status),
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
			for (let waits = 0; run.inflight > 0 && waits < 10; waits++)
				await Bun.sleep(50);
			for (const origin of run.origins) this.dirtyOrigins.add(origin);
			for (const url of [shell.finalUrl, startUrl]) {
				const parsed = URL.parse(url);
				if (parsed) this.dirtyOrigins.add(parsed.origin);
			}
			if (!(await this.reset())) await this.close();
			if (this.run === run) this.run = undefined;
		}
	}

	async close() {
		if (this.closed) return;
		this.closed = true;
		this.view.close();
	}

	private onRequest(params: JsonObject) {
		if (params["type"] === "Script")
			this.run?.scriptRequests.add(String(params["requestId"]));
	}

	private async onPaused(params: JsonObject) {
		const run = this.run;
		const requestId = String(params["requestId"]);
		if (!run) {
			await this.block(requestId).catch(() => undefined);
			return;
		}
		const request = pausedRequest(params["request"]);
		if (!request) {
			await this.block(requestId, run.signal).catch(() => undefined);
			return;
		}
		const type = String(params["resourceType"] ?? "Other");
		if (type === "Document" && !run.frameId)
			run.frameId = String(params["frameId"] ?? "");
		const workerScript = run.scriptRequests.delete(
			String(params["networkId"] ?? ""),
		);
		run.intercepted++;
		run.inflight++;
		try {
			if (
				run.shellFulfillment &&
				params["frameId"] === run.frameId &&
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
				await this.send(
					"Fetch.fulfillRequest",
					{
						requestId,
						responseCode: run.shell.status,
						responseHeaders: responseHeaderList(headers, contentType),
						body: Buffer.from(run.shell.body).toString("base64"),
					},
					run.signal,
				);
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
				return void (await this.block(requestId, run.signal));
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
				return void (await this.block(requestId, run.signal));
			}
			if (
				params["frameId"] === run.frameId &&
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
			await this.send(
				"Fetch.fulfillRequest",
				{
					requestId,
					responseCode: response.status,
					responseHeaders: responseHeaderList(response.headers),
					body: Buffer.from(response.body).toString("base64"),
				},
				run.signal,
			);
		} catch {
			await this.block(requestId, run.signal).catch(() => undefined);
		} finally {
			run.inflight--;
		}
	}

	private async configure() {
		const signal = AbortSignal.timeout(15_000);
		await this.send("Network.enable", {}, signal);
		await this.send(
			"Network.setBlockedURLs",
			{ urls: ["ws://*", "wss://*", "file://*", "ftp://*"] },
			signal,
		);
		await this.send("Network.setBypassServiceWorker", { bypass: true }, signal);
		await this.send(
			"Network.setUserAgentOverride",
			{ userAgent: this.config.userAgent },
			signal,
		);
		await this.send("Fetch.enable", { patterns: fetchPatterns }, signal);
		await this.send("Page.enable", {}, signal);
		await this.send(
			"Page.addScriptToEvaluateOnNewDocument",
			{ source: blockerSource },
			signal,
		);
		await this.send(
			"Browser.setDownloadBehavior",
			{ behavior: "deny" },
			signal,
		);
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

	private block(requestId: string, signal?: AbortSignal) {
		return this.send(
			"Fetch.failRequest",
			{ requestId, errorReason: "BlockedByClient" },
			signal,
		);
	}

	private async prepare(signal: AbortSignal) {
		await awaitWithSignal(this.start(), signal);
		await this.send("Network.clearBrowserCookies", {}, signal);
		await this.send("Network.clearBrowserCache", {}, signal);
		for (const origin of this.dirtyOrigins) {
			await this.send(
				"Storage.clearDataForOrigin",
				{ origin, storageTypes: "all" },
				signal,
			);
		}
		this.dirtyOrigins.clear();
	}

	private async reset() {
		if (this.closed) return false;
		try {
			await awaitWithSignal(
				this.view.navigate("about:blank"),
				AbortSignal.timeout(2_000),
			);
			return true;
		} catch {
			return false;
		}
	}

	private async settle(run: Run, requireContent = true) {
		const started = performance.now();
		const budget = Math.min(4_000, this.config.timeoutMs);
		let stableSince = started;
		let fingerprint = -1;
		let readySince = 0;
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
				(!requireContent || substantive) &&
				(pendingFrames === 0 || now - started >= 1_000);
			if (captureReady) readySince ||= now;
			else readySince = 0;
			if (
				captureReady &&
				now - stableSince >= 750 &&
				(run.inflight === 0 || now - readySince >= 3_000)
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
		const pending = this.evaluationQueue.then(() =>
			this.view.evaluate(expression),
		);
		this.evaluationQueue = pending.then(
			() => undefined,
			() => undefined,
		);
		return await awaitWithSignal(pending, signal);
	}

	private async send(
		method: string,
		params: JsonObject = {},
		signal?: AbortSignal,
	): Promise<JsonObject> {
		const pending = this.cdpQueue.then(() => this.view.cdp(method, params));
		this.cdpQueue = pending.then(
			() => undefined,
			() => undefined,
		);
		const value = await awaitWithSignal(
			pending,
			signal ?? AbortSignal.timeout(15_000),
		);
		if (!isJsonObject(value)) throw new Error(`CDP ${method}: invalid result`);
		return value;
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
			renderMs,
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

function message(cause: unknown) {
	return cause instanceof Error ? cause.message : String(cause);
}
