import type {
	Config,
	DiscoveredUrl,
	FailureKind,
	FetchedUrl,
	FetchResult,
} from "../core/types.ts";
import { runBounded } from "./rate-limit.ts";
import {
	isRetryableFetchError,
	isUnsafeUrlError,
	retryDelayMs,
	shouldRetry,
} from "./retry.ts";
import {
	type FetchTransport,
	type HttpResponse,
	requestPublicHttp,
} from "./transport.ts";
import { withWritersideTopic } from "./writerside.ts";

let fetchTransport: FetchTransport = requestPublicHttp;
export function setFetchTransportForTest(
	transport: FetchTransport | undefined,
): void {
	fetchTransport = transport ?? requestPublicHttp;
}

export async function fetchText(
	url: string,
	config: Config,
	accept = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
): Promise<FetchResult> {
	const started = performance.now();
	let currentUrl = url;
	const triedRouteFallbacks = new Set<string>();
	const seenRefreshes = new Set<string>();
	for (let refresh = 0; refresh < 8; refresh++) {
		const result = await fetchOnce(url, currentUrl, config, accept, started);
		const fallback = routeFallback(result, currentUrl);
		if (fallback && !triedRouteFallbacks.has(fallback)) {
			triedRouteFallbacks.add(fallback);
			currentUrl = fallback;
			continue;
		}
		const next = refreshUrl(result);
		if (!next || seenRefreshes.has(next)) return result;
		seenRefreshes.add(next);
		currentUrl = next;
	}
	return failed(url, currentUrl, 0, started, "too many meta refresh redirects");
}

async function fetchOnce(
	url: string,
	currentUrl: string,
	config: Config,
	accept: string,
	started: number,
): Promise<FetchResult> {
	let requestUrl = currentUrl;
	const seenRedirects = new Set<string>();
	const cookies: Cookie[] = [];
	for (let attempt = 0; attempt < 3; attempt++) {
		try {
			const headers: { accept: string; "user-agent": string; cookie?: string } =
				{
					accept,
					"user-agent": config.userAgent,
				};
			const cookie = cookieHeader(cookies, requestUrl);
			if (cookie) headers.cookie = cookie;
			const response = await fetchTransport(requestUrl, headers, config);
			storeCookies(cookies, requestUrl, response);
			const redirect = redirectUrl(response, requestUrl);
			if (redirect) {
				if (seenRedirects.has(redirect) || seenRedirects.size >= 8) {
					return failed(
						url,
						requestUrl,
						response.status,
						started,
						"too many redirects",
					);
				}
				seenRedirects.add(redirect);
				requestUrl = redirect;
				attempt = -1;
				continue;
			}
			const contentLength = Number(response.headers.get("content-length") ?? 0);
			if (contentLength > config.maxBytes) {
				return tooLarge(url, response, started, config);
			}
			if (shouldRetry(response.status) && attempt < 2) {
				await Bun.sleep(
					retryDelayMs(attempt, response.headers.get("retry-after")),
				);
				continue;
			}
			if (response.headers.get("x-amzn-waf-action"))
				return failed(
					url,
					requestUrl,
					response.status,
					started,
					"blocked by client challenge",
				);
			const body = await readBody(response, url, started, config);
			if (!body.ok) return body.result;
			const text = await withWritersideTopic(
				body.text,
				requestUrl,
				headers,
				config,
				fetchTransport,
			);
			const base = {
				url,
				finalUrl: requestUrl,
				status: response.status,
				contentType: response.headers.get("content-type") ?? "",
				body: text,
				fetchMs: performance.now() - started,
			};
			if (response.status >= 200 && response.status <= 299) {
				return { ...base, ok: true } satisfies FetchResult;
			}
			const error = `HTTP ${response.status}`;
			return {
				...base,
				ok: false,
				error,
				failureKind: failureKind(response.status, error),
			} satisfies FetchResult;
		} catch (error) {
			if (attempt < 2 && isRetryableFetchError(error)) {
				await Bun.sleep(retryDelayMs(attempt));
				continue;
			}
			return failed(
				url,
				requestUrl,
				0,
				started,
				error instanceof Error ? error.message : String(error),
			);
		}
	}
	return failed(url, currentUrl, 0, started, "fetch failed");
}

function redirectUrl(response: HttpResponse, base: string): string | undefined {
	if (response.status < 300 || response.status > 399) return undefined;
	const location = response.headers.get("location");
	if (!location) return undefined;
	try {
		const next = new URL(location, base);
		next.hash = "";
		return next.href;
	} catch {
		return undefined;
	}
}

type Cookie = {
	name: string;
	value: string;
	domain: string;
	hostOnly: boolean;
	secure: boolean;
};

function cookieHeader(cookies: Cookie[], raw: string) {
	const url = new URL(raw);
	const host = url.hostname.toLowerCase();
	return cookies
		.filter(
			(cookie) =>
				(!cookie.secure || url.protocol === "https:") &&
				(cookie.hostOnly
					? cookie.domain === host
					: host === cookie.domain || host.endsWith(`.${cookie.domain}`)),
		)
		.map((cookie) => `${cookie.name}=${cookie.value}`)
		.join("; ");
}

function storeCookies(cookies: Cookie[], raw: string, response: HttpResponse) {
	const host = new URL(raw).hostname.toLowerCase();
	const values = response.headers.getSetCookie?.() ?? [
		response.headers.get("set-cookie") ?? "",
	];
	for (const value of values) {
		const parts = value.split(";").map((part) => part.trim());
		const pair = parts[0];
		if (!pair) continue;
		const split = pair.indexOf("=");
		if (split <= 0) continue;
		const rawDomain = parts
			.find((part) => /^domain=/i.test(part))
			?.slice("domain=".length)
			.replace(/^\./, "")
			.toLowerCase();
		const domain =
			rawDomain && domainMatches(host, rawDomain) ? rawDomain : host;
		const cookie = {
			name: pair.slice(0, split),
			value: pair.slice(split + 1),
			domain,
			hostOnly: domain === host && rawDomain !== host,
			secure: parts.some((part) => /^secure$/i.test(part)),
		};
		const index = cookies.findIndex(
			(item) => item.name === cookie.name && item.domain === cookie.domain,
		);
		if (index >= 0) cookies[index] = cookie;
		else cookies.push(cookie);
	}
}

function domainMatches(host: string, domain: string) {
	return (
		domain.includes(".") && (host === domain || host.endsWith(`.${domain}`))
	);
}

function refreshUrl(result: FetchResult): string | undefined {
	if (!result.ok || !/html/i.test(result.contentType)) return undefined;
	const html = result.body.replace(/<noscript[\s\S]*?<\/noscript>/gi, "");
	const match = html.match(
		/<meta\b[^>]*http-equiv\s*=\s*["']?\s*refresh\s*["']?[^>]*>/i,
	);
	const target =
		refreshTarget(attributeValue(match?.[0], "content")) ??
		scriptRedirectTarget(html);
	if (!target) return undefined;
	try {
		const url = new URL(target.replace(/^['"]|['"]$/g, ""), result.finalUrl);
		url.hash = "";
		return url.href;
	} catch {
		return undefined;
	}
}
function refreshTarget(content: string | undefined): string | undefined {
	const explicit = content?.match(/(?:^|;)\s*url\s*=\s*(.+)\s*$/i)?.[1];
	if (explicit?.trim()) return explicit.trim();
	const implicit = content?.split(";").slice(1).join(";").trim();
	return implicit || undefined;
}

function attributeValue(
	tag: string | undefined,
	name: string,
): string | undefined {
	if (!tag) return undefined;
	const pattern = new RegExp(
		`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`,
		"i",
	);
	const match = tag.match(pattern);
	return match?.[1] ?? match?.[2] ?? match?.[3];
}

function scriptRedirectTarget(html: string): string | undefined {
	if (!/redirect(?:ing|ed(?: automatically)?)/i.test(html)) return undefined;
	const variables = new Map<string, string>();
	for (const match of html.matchAll(
		/(?:\b(?:const|let|var)\b|[,;])\s*([A-Za-z_$][\w$]*)\s*=\s*["']([^"']+)["']/g,
	)) {
		variables.set(match[1]!, match[2]!);
	}
	for (const match of html.matchAll(/location\.replace\(([^)]{1,240})\)/g)) {
		const target = evaluateStringExpression(match[1]!, variables);
		if (target) return target;
	}
	let assignment: string | undefined;
	for (const match of html.matchAll(
		/(?:window\.)?location(?:\.href)?\s*=\s*([^;\n]{1,240})/g,
	)) {
		assignment = evaluateStringExpression(match[1]!, variables) ?? assignment;
	}
	return assignment;
}

function evaluateStringExpression(
	expression: string,
	variables: Map<string, string>,
): string | undefined {
	let out = "";
	for (const part of expression.split("+")) {
		const token = part.trim();
		const literal = token.match(/^["']([^"']*)["']$/)?.[1];
		if (literal !== undefined) {
			out += literal;
			continue;
		}
		const template = token.match(/^`([^`$]*)`$/)?.[1];
		if (template !== undefined) {
			out += template;
			continue;
		}
		const variable = token.match(/^[A-Za-z_$][\w$]*$/)?.[0];
		if (variable && variables.has(variable)) {
			out += variables.get(variable);
			continue;
		}
		if (/^(?:window\.)?location\.(?:search|hash)$/.test(token)) continue;
		return undefined;
	}
	return out;
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
) {
	if (response.body.byteLength > config.maxBytes) {
		return {
			ok: false as const,
			result: tooLarge(url, response, started, config),
		};
	}
	return { ok: true as const, text: decodeBody(response, response.body) };
}

function decodeBody(response: HttpResponse, body: Uint8Array): string {
	for (const encoding of charsetCandidates(response, body)) {
		try {
			return new TextDecoder(encoding, { fatal: true }).decode(body);
		} catch {}
	}
	return new TextDecoder().decode(body);
}

function charsetCandidates(response: HttpResponse, body: Uint8Array): string[] {
	const seen = new Set<string>();
	const candidates = [
		bomEncoding(body),
		charsetFromContentType(response.headers.get("content-type")),
		charsetFromMeta(body),
		"utf-8",
	];
	return candidates.filter((candidate): candidate is string => {
		if (!candidate || seen.has(candidate)) return false;
		seen.add(candidate);
		return true;
	});
}

function bomEncoding(body: Uint8Array): string | undefined {
	if (body[0] === 0xef && body[1] === 0xbb && body[2] === 0xbf) return "utf-8";
	if (body[0] === 0xff && body[1] === 0xfe) return "utf-16le";
	if (body[0] === 0xfe && body[1] === 0xff) return "utf-16be";
	return undefined;
}

function charsetFromContentType(
	contentType: string | null,
): string | undefined {
	return cleanCharset(
		contentType?.match(/\bcharset\s*=\s*("[^"]+"|'[^']+'|[^;\s]+)/i)?.[1],
	);
}

function charsetFromMeta(body: Uint8Array): string | undefined {
	const head = new TextDecoder("windows-1252").decode(
		body.subarray(0, Math.min(body.length, 4096)),
	);
	return cleanCharset(
		head.match(
			/<meta\b[^>]*\bcharset\s*=\s*("[^"]+"|'[^']+'|[^\s"'/>]+)/i,
		)?.[1] ??
			head.match(
				/<meta\b[^>]*\bcontent\s*=\s*["'][^"']*\bcharset\s*=\s*([^"'\s;/>]+)/i,
			)?.[1],
	);
}

function cleanCharset(value: string | undefined): string | undefined {
	if (!value) return;
	return value
		.trim()
		.replace(/^["']|["']$/g, "")
		.toLowerCase();
}

function tooLarge(
	url: string,
	response: HttpResponse,
	started: number,
	config: Config,
) {
	const error = `response exceeds ${config.maxBytes} bytes`;
	return failed(url, response.url, response.status, started, error);
}

export function fetchMany(
	urls: DiscoveredUrl[],
	config: Config,
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
			result: item.fetched ?? (await fetchText(item.url, config)),
		}),
	);
}

function failed(
	url: string,
	finalUrl: string,
	status: number,
	started: number,
	error: string,
): FetchResult {
	return {
		url,
		finalUrl,
		status,
		contentType: "",
		body: "",
		ok: false,
		fetchMs: performance.now() - started,
		error,
		failureKind: failureKind(status, error),
	};
}

function failureKind(status: number, error: string): FailureKind {
	if (status === 404 || status === 410) return "not_found";
	if ([401, 403, 429].includes(status) || /blocked|challenge/i.test(error))
		return "blocked";
	if (/exceeds/i.test(error)) return "too_large";
	if (isUnsafeUrlError(error)) return "unsafe_url";
	if (/timeout|timed out|abort/i.test(error)) return "timeout";
	if (status > 0) return "http";
	return "fetch";
}
