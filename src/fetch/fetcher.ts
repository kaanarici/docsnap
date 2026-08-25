import { fetchWithCache, type UncachedFetch } from "../cache/cached-fetch.ts";
import { artifactUrl } from "../core/identity.ts";
import { awaitWithSignal, runBounded } from "../core/parallel.ts";
import { hasMarkdownBody } from "../core/text.ts";
import type {
	ConditionalRequest,
	DiscoveredUrl,
	FailureKind,
	FetchedUrl,
	FetchResult,
	HeaderMap,
	PipelineConfig,
	RedirectHop,
} from "../core/types.ts";
import { validatePublicHttpUrl } from "../security/url.ts";
import { decodeResponseBody, documentPayload } from "./body.ts";
import { type Cookie, cookieHeader, storeCookies } from "./cookies.ts";
import { refreshUrl } from "./refresh.ts";
import { failed, failureKind } from "./result.ts";
import {
	isRetryableFetchError,
	retryDelayMs,
	shouldRetry,
	thrownFetchKind,
} from "./retry.ts";
import { type HttpResponse, requestPublicHttp } from "./transport.ts";
import { withWritersideTopic } from "./writerside.ts";
export type FetchUrlGate = (url: string) => boolean | Promise<boolean>;
export const preferredMarkdownAccept = "text/markdown, text/plain, */*;q=0.8";
const responseHeaders = new WeakMap<FetchResult, HeaderMap>();

type RequestHeaders = {
	accept: string;
	"user-agent": string;
	cookie?: string;
	"if-none-match"?: string;
	"if-modified-since"?: string;
};

type ConditionalHeaders = {
	"if-none-match"?: string;
	"if-modified-since"?: string;
};

type ResponseMetadata = Pick<FetchResult, "fetchedAt"> &
	Partial<
		Pick<
			FetchResult,
			| "etag"
			| "lastModified"
			| "cacheControl"
			| "ageSeconds"
			| "vary"
			| "setCookie"
		>
	>;

type FetchDiscovery = Pick<FetchedUrl, "source" | "wasSeed" | "metadata">;

export function responseHeadersFor(result: FetchResult) {
	return responseHeaders.get(result);
}

interface FetchTextOptions {
	followRouteFallbacks?: boolean;
	signal?: AbortSignal;
	maxBytes?: number;
}
export async function fetchText(
	url: string,
	config: PipelineConfig,
	accept = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
	conditional?: ConditionalRequest,
	allowUrl?: FetchUrlGate,
	options?: FetchTextOptions,
): Promise<FetchResult> {
	const signal = deadlineSignal(options?.signal, config.timeoutMs);
	const fetchOptions = { ...options, signal };
	const uncached: UncachedFetch = (...args) =>
		fetchTextUncached(...args, fetchOptions);
	try {
		return await awaitWithSignal(
			fetchWithCache(url, config, accept, conditional, uncached, allowUrl),
			signal,
		);
	} catch (error) {
		if (signal.aborted) {
			return fail(url, url, 0, "request timed out", "timeout", []);
		}
		throw error;
	}
}

export async function fetchTextUncached(
	url: string,
	config: PipelineConfig,
	accept: string,
	conditional?: ConditionalRequest,
	allowUrl?: FetchUrlGate,
	options: FetchTextOptions = {},
): Promise<FetchResult> {
	const signal = deadlineSignal(options.signal, config.timeoutMs);
	const maxBytes = Math.min(
		config.maxBytes,
		options.maxBytes ?? config.maxBytes,
	);
	let currentUrl = url;
	let redirects: RedirectHop[] = [];
	const triedRouteFallbacks = new Set<string>();
	const seenRefreshes = new Set<string>();
	for (let refresh = 0; refresh < 8; refresh++) {
		const result = await fetchOnce(
			url,
			currentUrl,
			config,
			accept,
			conditional,
			redirects,
			allowUrl,
			signal,
			maxBytes,
		);
		const fallback =
			options.followRouteFallbacks !== false
				? routeFallback(result, currentUrl)
				: undefined;
		if (fallback && !triedRouteFallbacks.has(fallback)) {
			redirects = result.redirects ?? redirects;
			if (!(await urlAllowed(fallback, allowUrl, signal))) {
				const [error, kind] = deniedUrl(fallback, signal);
				return fail(url, fallback, result.status, error, kind, redirects);
			}
			triedRouteFallbacks.add(fallback);
			currentUrl = fallback;
			continue;
		}
		const next = refreshUrl(result);
		if (!next || seenRefreshes.has(next)) return result;
		redirects = [...(result.redirects ?? [])];
		const hop = redirectHop(result.finalUrl, next, "refresh", result.status);
		if (hop) redirects.push(hop);
		if (!(await urlAllowed(next, allowUrl, signal))) {
			const [error, kind] = deniedUrl(next, signal);
			return fail(url, next, result.status, error, kind, redirects);
		}
		seenRefreshes.add(next);
		currentUrl = next;
	}
	return fail(
		url,
		currentUrl,
		0,
		"too many meta refresh redirects",
		"fetch",
		redirects,
	);
}

function deadlineSignal(signal: AbortSignal | undefined, timeoutMs: number) {
	const timeout = AbortSignal.timeout(timeoutMs);
	return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

async function fetchOnce(
	url: string,
	currentUrl: string,
	config: PipelineConfig,
	accept: string,
	conditional: ConditionalRequest | undefined,
	redirectsSoFar: RedirectHop[],
	allowUrl: FetchUrlGate | undefined,
	signal: AbortSignal | undefined,
	maxBytes: number,
): Promise<FetchResult> {
	let requestUrl = currentUrl;
	const redirects = [...redirectsSoFar];
	const failure = (
		finalUrl: string,
		status: number,
		error: string,
		kind: FailureKind,
	) => fail(url, finalUrl, status, error, kind, redirects);
	const seenRedirects = new Set<string>();
	const cookies: Cookie[] = [];
	let cookieTainted = false;
	for (let attempt = 0; attempt < 3; attempt++) {
		try {
			signal?.throwIfAborted();
			const headers: RequestHeaders = {
				accept,
				"user-agent": config.userAgent,
			};
			const sentConditional = conditionalHeaders(conditional, requestUrl);
			Object.assign(headers, sentConditional);
			const cookie = cookieHeader(cookies, requestUrl);
			if (cookie) {
				headers.cookie = cookie;
				cookieTainted = true;
			}
			const requestStarted = performance.now();
			const requestOptions = signal ? { signal, maxBytes } : { maxBytes };
			const response = await requestPublicHttp(
				requestUrl,
				headers,
				config,
				requestOptions,
			);
			cookieTainted ||= responseSetsCookie(response);
			storeCookies(cookies, requestUrl, response);
			const redirect = redirectUrl(response, requestUrl);
			if (redirect) {
				if (redirect instanceof Error) {
					return failure(
						requestUrl,
						response.status,
						redirect.message,
						"unsafe_url",
					);
				}
				if (seenRedirects.has(redirect) || seenRedirects.size >= 8) {
					return failure(
						requestUrl,
						response.status,
						"too many redirects",
						"http",
					);
				}
				const hop = redirectHop(requestUrl, redirect, "http", response.status);
				if (hop) redirects.push(hop);
				if (!(await urlAllowed(redirect, allowUrl, signal))) {
					const [error, kind] = deniedUrl(redirect, signal);
					return failure(redirect, response.status, error, kind);
				}
				seenRedirects.add(redirect);
				requestUrl = redirect;
				attempt = -1;
				continue;
			}
			const contentLength = Number(response.headers.get("content-length") ?? 0);
			if (contentLength > maxBytes) {
				return failure(
					response.url,
					response.status,
					`response exceeds ${maxBytes} bytes`,
					"too_large",
				);
			}
			if (shouldRetry(response.status, attempt)) {
				await awaitWithSignal(
					Bun.sleep(retryDelayMs(attempt, response.headers.get("retry-after"))),
					signal,
				);
				continue;
			}
			if (response.headers.get("x-amzn-waf-action"))
				return failure(
					requestUrl,
					response.status,
					"blocked by client challenge",
					"blocked",
				);
			const fetchedAt = new Date().toISOString();
			const base = {
				url,
				finalUrl: artifactFinalUrl(requestUrl, url),
				status: response.status,
				contentType: response.headers.get("content-type") ?? "",
				body: "",
				redirects,
				...responseMetadata(response, requestStarted, fetchedAt, cookieTainted),
			};
			if (response.status === 304 && Object.keys(sentConditional).length > 0) {
				return {
					...base,
					status: 304,
					body: "",
					ok: true,
					notModified: true,
				} satisfies FetchResult;
			}
			const document =
				response.status >= 200 && response.status <= 299
					? documentPayload(response, response.body)
					: undefined;
			const body = document
				? ""
				: await withWritersideTopic(
						decodeResponseBody(response, response.body),
						requestUrl,
						headers,
						config,
						allowUrl,
						signal,
					);
			const full = document ? { ...base, body, document } : { ...base, body };
			let result: FetchResult;
			if (response.status >= 200 && response.status <= 299) {
				result = { ...full, ok: true };
			} else {
				result = {
					...full,
					ok: false,
					error: `HTTP ${response.status}`,
					failureKind: failureKind(response.status),
				};
			}
			responseHeaders.set(result, response.headers);
			return result;
		} catch (error) {
			if (signal?.aborted) {
				return failure(requestUrl, 0, "request timed out", "timeout");
			}
			if (attempt < 2 && isRetryableFetchError(error)) {
				await awaitWithSignal(Bun.sleep(retryDelayMs(attempt)), signal);
				continue;
			}
			return failure(
				requestUrl,
				0,
				error instanceof Error ? error.message : String(error),
				thrownFetchKind(error),
			);
		}
	}
	return fail(url, currentUrl, 0, "fetch failed", "fetch", redirects);
}

async function urlAllowed(
	url: string,
	allowUrl: FetchUrlGate | undefined,
	signal?: AbortSignal,
) {
	if (!allowUrl) return true;
	try {
		const parsed = new URL(url);
		if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
			return true;
	} catch {
		return true;
	}
	try {
		return await awaitWithSignal(Promise.resolve(allowUrl(url)), signal);
	} catch {
		return false;
	}
}

function deniedUrl(url: string, signal?: AbortSignal): [string, FailureKind] {
	if (signal?.aborted) return ["request timed out", "timeout"];
	const unsafe = validatePublicHttpUrl(url);
	return unsafe
		? [`unsafe URL: ${unsafe}`, "unsafe_url"]
		: ["blocked by robots.txt", "blocked"];
}
function redirectUrl(
	response: HttpResponse,
	base: string,
): string | Error | undefined {
	if (response.status < 300 || response.status > 399) return undefined;
	const location = response.headers.get("location");
	if (!location) return undefined;
	try {
		const next = new URL(location, base);
		if (next.protocol !== "http:" && next.protocol !== "https:") {
			return new Error("unsafe URL: redirect to unsupported scheme");
		}
		next.hash = "";
		return next.href;
	} catch {
		return undefined;
	}
}

function conditionalHeaders(
	conditional: ConditionalRequest | undefined,
	requestUrl: string,
): ConditionalHeaders {
	const request = artifactUrl(requestUrl);
	if (
		!conditional ||
		!request ||
		!conditional.urls.some((url) => artifactUrl(url) === request)
	)
		return {};
	const headers: ConditionalHeaders = {};
	if (conditional.etag) headers["if-none-match"] = conditional.etag;
	if (conditional.lastModified) {
		headers["if-modified-since"] = conditional.lastModified;
	}
	return headers;
}

function responseMetadata(
	response: HttpResponse,
	started: number,
	fetchedAt: string,
	cookieTainted: boolean,
) {
	const etag = cleanHeader(response.headers.get("etag"));
	const lastModified = cleanHeader(response.headers.get("last-modified"));
	const cacheControl = cleanHeader(response.headers.get("cache-control"));
	const ageSeconds = responseAgeSeconds(response, started);
	const vary = cleanHeader(response.headers.get("vary"));
	const setCookie = cookieTainted || responseSetsCookie(response);
	const metadata: ResponseMetadata = { fetchedAt };
	if (etag) metadata.etag = etag;
	if (lastModified) metadata.lastModified = lastModified;
	if (cacheControl) metadata.cacheControl = cacheControl;
	if (ageSeconds) metadata.ageSeconds = ageSeconds;
	if (vary) metadata.vary = vary;
	if (setCookie) metadata.setCookie = true;
	return metadata;
}

function responseSetsCookie(response: HttpResponse) {
	return (
		(response.headers.getSetCookie?.().length ?? 0) > 0 ||
		response.headers.get("set-cookie") !== null
	);
}

function responseAgeSeconds(response: HttpResponse, started: number) {
	const age = cleanHeader(response.headers.get("age"));
	const ageValue = age && /^\d+$/.test(age) ? Number(age) : 0;
	const dateValue = Date.parse(response.headers.get("date") ?? "");
	const apparentAge = Number.isNaN(dateValue)
		? 0
		: Math.max(0, (Date.now() - dateValue) / 1000);
	const responseDelay = (performance.now() - started) / 1000;
	return Math.min(
		Math.ceil(Math.max(apparentAge, ageValue + responseDelay)),
		86_400,
	);
}

const cleanHeader = (value: string | null) => value?.trim() || undefined;

function redirectHop(
	from: string,
	to: string,
	type: RedirectHop["type"],
	status?: number,
): RedirectHop | undefined {
	const cleanFrom = artifactUrl(from);
	const cleanTo = artifactUrl(to);
	if (!cleanFrom || !cleanTo) return undefined;
	const redirect: RedirectHop = { from: cleanFrom, to: cleanTo, type };
	if (status) redirect.status = status;
	return redirect;
}

function artifactFinalUrl(raw: string, fallback: string) {
	return artifactUrl(raw) ?? artifactUrl(fallback) ?? fallback;
}

function fail(
	url: string,
	finalUrl: string,
	status: number,
	error: string,
	kind: FailureKind,
	redirects: RedirectHop[],
): FetchResult {
	return failed(
		url,
		artifactFinalUrl(finalUrl, url),
		status,
		error,
		kind,
		redirects,
	);
}

function routeFallback(
	result: FetchResult,
	currentUrl: string,
): string | undefined {
	let url: URL;
	try {
		url = new URL(currentUrl);
	} catch {
		return undefined;
	}
	if (result.ok && result.notModified) return undefined;
	if (url.pathname.endsWith(".html") && [404, 410].includes(result.status))
		return withoutExtension(url, ".html");
	if (!url.pathname.endsWith(".md")) return undefined;
	if (
		result.status !== 404 &&
		result.status !== 410 &&
		(!result.ok || hasMarkdownBody(result.body))
	) {
		return undefined;
	}
	return docsMarkdownFallback(url) ?? withoutExtension(url, ".md");
}
function withoutExtension(url: URL, extension: string) {
	url.pathname = url.pathname.slice(0, -extension.length);
	url.hash = "";
	return url.href;
}
function docsMarkdownFallback(url: URL): string | undefined {
	const parts = url.pathname.split("/").filter(Boolean);
	if (parts.length !== 1 || parts[0]?.toLowerCase() === "docs.md")
		return undefined;
	const next = new URL(url);
	next.pathname = `/docs/${parts[0]}`;
	next.hash = "";
	return next.href;
}

export function fetchMany(
	urls: DiscoveredUrl[],
	config: PipelineConfig,
	conditionalFor?: (item: DiscoveredUrl) => ConditionalRequest | undefined,
	allowUrl?: FetchUrlGate,
): Promise<FetchedUrl[]> {
	return runBounded(
		urls,
		{
			concurrency: config.concurrency,
			perOrigin: config.perOrigin,
			key: (item) => new URL(item.url).origin,
		},
		(item) => fetchDiscovered(item, config, conditionalFor, allowUrl),
	);
}

type CompletedFetch = {
	id: number;
	result: FetchedUrl;
	origin: string;
};

export async function* fetchBatches(
	urls: DiscoveredUrl[],
	config: PipelineConfig,
	conditionalFor?: (item: DiscoveredUrl) => ConditionalRequest | undefined,
	allowUrl?: FetchUrlGate,
): AsyncGenerator<FetchedUrl[]> {
	const queue = [...urls];
	const active = new Map<number, Promise<CompletedFetch>>();
	const activeByOrigin = new Map<string, number>();
	const controller = new AbortController();
	const batchSize = Math.min(64, config.concurrency);
	let nextId = 0;

	try {
		fill();
		let batch: FetchedUrl[] = [];
		while (active.size > 0) {
			const completed = await Promise.race(active.values());
			active.delete(completed.id);
			const count = (activeByOrigin.get(completed.origin) ?? 1) - 1;
			if (count) activeByOrigin.set(completed.origin, count);
			else activeByOrigin.delete(completed.origin);
			batch.push(completed.result);
			fill();
			if (batch.length === batchSize) {
				yield batch;
				batch = [];
			}
		}
		if (batch.length) yield batch;
	} finally {
		controller.abort();
		await Promise.allSettled(active.values());
	}

	function fill() {
		while (active.size < config.concurrency) {
			const index = queue.findIndex((item) => {
				const origin = new URL(item.url).origin;
				return (activeByOrigin.get(origin) ?? 0) < config.perOrigin;
			});
			if (index < 0) return;
			const [item] = queue.splice(index, 1);
			if (!item) return;
			const origin = new URL(item.url).origin;
			activeByOrigin.set(origin, (activeByOrigin.get(origin) ?? 0) + 1);
			const id = nextId++;
			active.set(
				id,
				fetchDiscovered(
					item,
					config,
					conditionalFor,
					allowUrl,
					controller.signal,
				).then((result) => ({ id, result, origin })),
			);
		}
	}
}

async function fetchDiscovered(
	item: DiscoveredUrl,
	config: PipelineConfig,
	conditionalFor?: (item: DiscoveredUrl) => ConditionalRequest | undefined,
	allowUrl?: FetchUrlGate,
	signal?: AbortSignal,
): Promise<FetchedUrl> {
	const discovery: FetchDiscovery = { source: item.source };
	if (item.wasSeed) discovery.wasSeed = true;
	if (item.metadata) discovery.metadata = item.metadata;
	if (
		item.fetched &&
		!item.fetched.ok &&
		item.fetched.error === "blocked by robots.txt"
	) {
		return { ...discovery, result: item.fetched };
	}
	const conditional = conditionalFor?.(item);
	const accept =
		config.pageOnly && item.wasSeed ? preferredMarkdownAccept : undefined;
	const result =
		item.fetched ??
		(await fetchText(
			item.url,
			config,
			accept,
			conditional,
			allowUrl,
			signal ? { signal } : undefined,
		));
	return { ...discovery, result };
}
