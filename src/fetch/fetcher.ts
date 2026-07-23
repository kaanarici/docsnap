import { fetchWithCache, type UncachedFetch } from "../cache/cached-fetch.ts";
import { awaitWithSignal, runBounded } from "../core/parallel.ts";
import { hasMarkdownBody } from "../core/text.ts";
import type {
	ConditionalRequest,
	DiscoveredUrl,
	FetchedUrl,
	FetchResult,
	PipelineConfig,
	RedirectHop,
} from "../core/types.ts";
import { decodeResponseBody } from "./body.ts";
import { type Cookie, cookieHeader, storeCookies } from "./cookies.ts";
import { refreshUrl } from "./refresh.ts";
import { failed, failureKind } from "./result.ts";
import { isRetryableFetchError, retryDelayMs, shouldRetry } from "./retry.ts";
import { type HttpResponse, requestPublicHttp } from "./transport.ts";
import { withWritersideTopic } from "./writerside.ts";
export type FetchUrlGate = (url: string) => boolean | Promise<boolean>;
export const preferredMarkdownAccept = "text/markdown, text/plain, */*;q=0.8";
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
	const started = performance.now();
	const signal = deadlineSignal(options?.signal, config.timeoutMs);
	const fetchOptions = { ...(options ?? {}), signal };
	const uncached: UncachedFetch = (
		raw,
		fetchConfig,
		nextAccept,
		nextConditional,
		nextAllowUrl,
	) =>
		fetchTextUncached(
			raw,
			fetchConfig,
			nextAccept,
			nextConditional,
			nextAllowUrl,
			fetchOptions,
		);
	try {
		return await awaitWithSignal(
			fetchWithCache(url, config, accept, conditional, uncached, allowUrl),
			signal,
		);
	} catch (error) {
		if (signal.aborted) {
			return fail(url, url, 0, started, "request timed out", []);
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
	const started = performance.now();
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
			started,
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
				return fail(
					url,
					fallback,
					result.status,
					started,
					signal.aborted ? "request timed out" : "blocked by robots.txt",
					redirects,
				);
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
			return fail(
				url,
				next,
				result.status,
				started,
				signal.aborted ? "request timed out" : "blocked by robots.txt",
				redirects,
			);
		}
		seenRefreshes.add(next);
		currentUrl = next;
	}
	return fail(
		url,
		currentUrl,
		0,
		started,
		"too many meta refresh redirects",
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
	started: number,
	redirectsSoFar: RedirectHop[],
	allowUrl: FetchUrlGate | undefined,
	signal: AbortSignal | undefined,
	maxBytes: number,
): Promise<FetchResult> {
	let requestUrl = currentUrl;
	const redirects = [...redirectsSoFar];
	const seenRedirects = new Set<string>();
	const cookies: Cookie[] = [];
	for (let attempt = 0; attempt < 3; attempt++) {
		try {
			signal?.throwIfAborted();
			const headers: { accept: string; "user-agent": string; cookie?: string } =
				{
					accept,
					"user-agent": config.userAgent,
				};
			const sentConditional = conditionalHeaders(conditional, requestUrl);
			Object.assign(headers, sentConditional);
			const cookie = cookieHeader(cookies, requestUrl);
			if (cookie) headers.cookie = cookie;
			const requestStarted = performance.now();
			const response = await requestPublicHttp(requestUrl, headers, config, {
				...(signal ? { signal } : {}),
				maxBytes,
			});
			storeCookies(cookies, requestUrl, response);
			const redirect = redirectUrl(response, requestUrl);
			if (redirect) {
				if (redirect instanceof Error) {
					return fail(
						url,
						requestUrl,
						response.status,
						started,
						redirect.message,
						redirects,
					);
				}
				if (seenRedirects.has(redirect) || seenRedirects.size >= 8) {
					return fail(
						url,
						requestUrl,
						response.status,
						started,
						"too many redirects",
						redirects,
					);
				}
				const hop = redirectHop(requestUrl, redirect, "http", response.status);
				if (hop) redirects.push(hop);
				if (!(await urlAllowed(redirect, allowUrl, signal))) {
					return fail(
						url,
						redirect,
						response.status,
						started,
						signal?.aborted ? "request timed out" : "blocked by robots.txt",
						redirects,
					);
				}
				seenRedirects.add(redirect);
				requestUrl = redirect;
				attempt = -1;
				continue;
			}
			const contentLength = Number(response.headers.get("content-length") ?? 0);
			if (contentLength > maxBytes) {
				return tooLarge(url, response, started, maxBytes, redirects);
			}
			if (shouldRetry(response.status, attempt)) {
				await awaitWithSignal(
					Bun.sleep(retryDelayMs(attempt, response.headers.get("retry-after"))),
					signal,
				);
				continue;
			}
			if (response.headers.get("x-amzn-waf-action"))
				return fail(
					url,
					requestUrl,
					response.status,
					started,
					"blocked by client challenge",
					redirects,
				);
			const fetchedAt = new Date().toISOString();
			const base = {
				url,
				finalUrl: artifactFinalUrl(requestUrl, url),
				status: response.status,
				contentType: response.headers.get("content-type") ?? "",
				body: "",
				fetchMs: performance.now() - started,
				redirects,
				...responseValidators(response, fetchedAt),
				...responseCache(response, requestStarted),
			};
			// 304 only counts as not-modified when we sent a validator for this URL.
			if (response.status === 304 && Object.keys(sentConditional).length > 0) {
				return {
					...base,
					status: 304,
					body: "",
					ok: true,
					notModified: true,
				} satisfies FetchResult;
			}
			const decoded = decodeResponseBody(response, response.body);
			const text = await withWritersideTopic(
				decoded,
				requestUrl,
				headers,
				config,
				allowUrl,
				signal,
			);
			const full = { ...base, body: text };
			if (response.status >= 200 && response.status <= 299) {
				return { ...full, ok: true } satisfies FetchResult;
			}
			return {
				...full,
				ok: false,
				error: `HTTP ${response.status}`,
				failureKind: failureKind(response.status, `HTTP ${response.status}`),
			} satisfies FetchResult;
		} catch (error) {
			if (signal?.aborted) {
				return fail(
					url,
					requestUrl,
					0,
					started,
					"request timed out",
					redirects,
				);
			}
			if (attempt < 2 && isRetryableFetchError(error)) {
				await awaitWithSignal(Bun.sleep(retryDelayMs(attempt)), signal);
				continue;
			}
			return fail(
				url,
				requestUrl,
				0,
				started,
				error instanceof Error ? error.message : String(error),
				redirects,
			);
		}
	}
	return fail(url, currentUrl, 0, started, "fetch failed", redirects);
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
): Partial<Record<"if-none-match" | "if-modified-since", string>> {
	if (!conditional || !conditionalApplies(conditional, requestUrl)) return {};
	return {
		...(conditional.etag ? { "if-none-match": conditional.etag } : {}),
		...(conditional.lastModified
			? { "if-modified-since": conditional.lastModified }
			: {}),
	};
}

function conditionalApplies(
	conditional: ConditionalRequest,
	requestUrl: string,
) {
	const request = artifactUrl(requestUrl);
	return Boolean(
		request &&
			conditional.urls
				.map(artifactUrl)
				.some((url) => url !== undefined && url === request),
	);
}

function responseValidators(response: HttpResponse, fetchedAt: string) {
	const etag = cleanHeader(response.headers.get("etag"));
	const lastModified = cleanHeader(response.headers.get("last-modified"));
	return {
		...(etag ? { etag } : {}),
		...(lastModified ? { lastModified } : {}),
		fetchedAt,
	};
}

function responseCache(response: HttpResponse, started: number) {
	const cacheControl = cleanHeader(response.headers.get("cache-control"));
	const ageSeconds = responseAgeSeconds(response, started);
	const vary = cleanHeader(response.headers.get("vary"));
	const setCookie =
		(response.headers.getSetCookie?.().length ?? 0) > 0 ||
		response.headers.get("set-cookie") !== null;
	return {
		...(cacheControl ? { cacheControl } : {}),
		...(ageSeconds ? { ageSeconds } : {}),
		...(vary ? { vary } : {}),
		...(setCookie ? { setCookie: true } : {}),
	};
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
	return { from: cleanFrom, to: cleanTo, type, ...(status ? { status } : {}) };
}

function artifactFinalUrl(raw: string, fallback: string) {
	return artifactUrl(raw) ?? artifactUrl(fallback) ?? fallback;
}

function artifactUrl(raw: string): string | undefined {
	try {
		const url = new URL(raw);
		if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
		url.username = "";
		url.password = "";
		url.hash = "";
		return url.href;
	} catch {
		return undefined;
	}
}

function fail(
	url: string,
	finalUrl: string,
	status: number,
	started: number,
	error: string,
	redirects: RedirectHop[],
): FetchResult {
	return failed(
		url,
		artifactFinalUrl(finalUrl, url),
		status,
		started,
		error,
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

function tooLarge(
	url: string,
	response: HttpResponse,
	started: number,
	maxBytes: number,
	redirects: RedirectHop[],
) {
	const error = `response exceeds ${maxBytes} bytes`;
	return fail(url, response.url, response.status, started, error, redirects);
}
export function fetchMany(
	urls: DiscoveredUrl[],
	config: PipelineConfig,
	conditionalFor?: (item: DiscoveredUrl) => ConditionalRequest | undefined,
	allowUrl?: FetchUrlGate,
): Promise<FetchedUrl[]> {
	return runBounded(
		[...urls],
		{
			concurrency: config.concurrency,
			perOrigin: config.perOrigin,
			key: (item) => new URL(item.url).origin,
		},
		async (item): Promise<FetchedUrl> => {
			const discovery = {
				source: item.source,
				...(item.wasSeed ? { wasSeed: true as const } : {}),
				...(item.metadata ? { metadata: item.metadata } : {}),
			};
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
				(await fetchText(item.url, config, accept, conditional, allowUrl));
			return { ...discovery, result };
		},
	);
}
