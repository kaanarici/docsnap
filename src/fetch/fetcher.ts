import { fetchWithCache } from "../cache/fetch.ts";
import type {
	ConditionalRequest,
	Config,
	DiscoveredUrl,
	FetchedUrl,
	FetchResult,
	RedirectHop,
} from "../core/types.ts";
import { decodeResponseBody } from "./body.ts";
import { type Cookie, cookieHeader, storeCookies } from "./cookies.ts";
import { runBounded } from "./rate-limit.ts";
import { refreshUrl } from "./refresh.ts";
import { failed, failureKind } from "./result.ts";
import { isRetryableFetchError, retryDelayMs, shouldRetry } from "./retry.ts";
import {
	type FetchTransport,
	type HttpResponse,
	requestPublicHttp,
} from "./transport.ts";
import { withWritersideTopic } from "./writerside.ts";

const cacheDirEnv = "DOCSNAP_CACHE_DIR";
let fetchTransport: FetchTransport = requestPublicHttp;
export type FetchUrlGate = (url: string) => boolean | Promise<boolean>;
export function setFetchTransportForTest(
	transport: FetchTransport | undefined,
) {
	fetchTransport = transport ?? requestPublicHttp;
}
export async function fetchText(
	url: string,
	config: Config,
	accept = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
	conditional?: ConditionalRequest,
	allowUrl?: FetchUrlGate,
): Promise<FetchResult> {
	if (fetchTransport !== requestPublicHttp && !process.env[cacheDirEnv])
		return fetchTextUncached(url, config, accept, conditional, allowUrl);
	return fetchWithCache(
		url,
		config,
		accept,
		conditional,
		fetchTextUncached,
		allowUrl,
	);
}
export async function fetchTextUncached(
	url: string,
	config: Config,
	accept: string,
	conditional?: ConditionalRequest,
	allowUrl?: FetchUrlGate,
): Promise<FetchResult> {
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
		);
		const fallback = routeFallback(result, currentUrl);
		if (fallback && !triedRouteFallbacks.has(fallback)) {
			redirects = result.redirects ?? redirects;
			if (!(await urlAllowed(fallback, allowUrl))) {
				return fail(
					url,
					fallback,
					result.status,
					started,
					"blocked by robots.txt",
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
		if (!(await urlAllowed(next, allowUrl))) {
			return fail(
				url,
				next,
				result.status,
				started,
				"blocked by robots.txt",
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

async function fetchOnce(
	url: string,
	currentUrl: string,
	config: Config,
	accept: string,
	conditional: ConditionalRequest | undefined,
	started: number,
	redirectsSoFar: RedirectHop[],
	allowUrl: FetchUrlGate | undefined,
): Promise<FetchResult> {
	let requestUrl = currentUrl;
	const redirects = [...redirectsSoFar];
	const seenRedirects = new Set<string>();
	const cookies: Cookie[] = [];
	for (let attempt = 0; attempt < 3; attempt++) {
		try {
			const headers: { accept: string; "user-agent": string; cookie?: string } =
				{
					accept,
					"user-agent": config.userAgent,
				};
			Object.assign(headers, conditionalHeaders(conditional, requestUrl));
			const cookie = cookieHeader(cookies, requestUrl);
			if (cookie) headers.cookie = cookie;
			const response = await fetchTransport(requestUrl, headers, config);
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
				if (!(await urlAllowed(redirect, allowUrl))) {
					return fail(
						url,
						redirect,
						response.status,
						started,
						"blocked by robots.txt",
						redirects,
					);
				}
				seenRedirects.add(redirect);
				requestUrl = redirect;
				attempt = -1;
				continue;
			}
			const contentLength = Number(response.headers.get("content-length") ?? 0);
			if (contentLength > config.maxBytes) {
				return tooLarge(url, response, started, config, redirects);
			}
			if (shouldRetry(response.status, attempt, config.retryHttp !== false)) {
				await Bun.sleep(
					retryDelayMs(attempt, response.headers.get("retry-after")),
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
				...responseCache(response),
			};
			if (response.status === 304) {
				return {
					...base,
					status: 304,
					body: "",
					ok: true,
					notModified: true,
				} satisfies FetchResult;
			}
			const body = await readBody(response, url, started, config, redirects);
			if (!body.ok) return body.result;
			const text = await withWritersideTopic(
				body.text,
				requestUrl,
				headers,
				config,
				fetchTransport,
				allowUrl,
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
			if (attempt < 2 && isRetryableFetchError(error)) {
				await Bun.sleep(retryDelayMs(attempt));
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

async function urlAllowed(url: string, allowUrl: FetchUrlGate | undefined) {
	if (!allowUrl) return true;
	try {
		const parsed = new URL(url);
		if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
			return true;
	} catch {
		return true;
	}
	try {
		return await allowUrl(url);
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

function responseCache(response: HttpResponse) {
	const cacheControl = cleanHeader(response.headers.get("cache-control"));
	const vary = cleanHeader(response.headers.get("vary"));
	const setCookie =
		(response.headers.getSetCookie?.().length ?? 0) > 0 ||
		response.headers.get("set-cookie") !== null;
	return {
		...(cacheControl ? { cacheControl } : {}),
		...(vary ? { vary } : {}),
		...(setCookie ? { setCookie: true } : {}),
	};
}

function cleanHeader(value: string | null) {
	const trimmed = value?.trim();
	return trimmed || undefined;
}

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
	if (url.pathname.endsWith(".html") && [404, 410].includes(result.status))
		return withoutExtension(url, ".html");
	if (!url.pathname.endsWith(".md")) return undefined;
	if (
		result.status !== 404 &&
		result.status !== 410 &&
		(!result.ok ||
			!(result.body.trim() === "" || isFrontmatterOnly(result.body)))
	) {
		return undefined;
	}
	const docsPath = docsMarkdownFallback(url);
	if (docsPath) return docsPath;
	return withoutExtension(url, ".md");
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

function isFrontmatterOnly(markdown: string): boolean {
	const trimmed = markdown.trim();
	if (!trimmed.startsWith("---")) return false;
	const end = trimmed.indexOf("\n---", 3);
	if (end < 0) return false;
	return trimmed.slice(end + 4).trim().length === 0;
}

async function readBody(
	response: HttpResponse,
	url: string,
	started: number,
	config: Config,
	redirects: RedirectHop[],
) {
	if (response.body.byteLength > config.maxBytes) {
		return {
			ok: false as const,
			result: tooLarge(url, response, started, config, redirects),
		};
	}
	return {
		ok: true as const,
		text: decodeResponseBody(response, response.body),
	};
}

function tooLarge(
	url: string,
	response: HttpResponse,
	started: number,
	config: Config,
	redirects: RedirectHop[],
) {
	const error = `response exceeds ${config.maxBytes} bytes`;
	return fail(url, response.url, response.status, started, error, redirects);
}
export function fetchMany(
	urls: DiscoveredUrl[],
	config: Config,
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
		async (item): Promise<FetchedUrl> => ({
			source: item.source,
			...(item.metadata ? { metadata: item.metadata } : {}),
			result:
				item.fetched ??
				(await fetchText(
					item.url,
					config,
					undefined,
					conditionalFor?.(item),
					allowUrl,
				)),
		}),
	);
}
