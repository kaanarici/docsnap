import type {
	Config,
	DiscoveredUrl,
	FailureKind,
	FetchedUrl,
	FetchResult,
} from "../core/types.ts";
import { runBounded } from "./rate-limit.ts";
import { retryDelayMs, shouldRetry } from "./retry.ts";

export async function fetchText(
	url: string,
	config: Config,
	accept = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
): Promise<FetchResult> {
	const started = performance.now();
	let currentUrl = url;
	const seenRefreshes = new Set<string>();
	for (let refresh = 0; refresh < 3; refresh++) {
		const result = await fetchOnce(url, currentUrl, config, accept, started);
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
	for (let attempt = 0; attempt < 3; attempt++) {
		try {
			const response = await fetch(currentUrl, {
				redirect: "follow",
				signal: AbortSignal.timeout(config.timeoutMs),
				headers: {
					accept,
					"user-agent": config.userAgent,
				},
			});
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
			const body = await readBody(response, url, started, config);
			if (!body.ok) return body.result;
			const base = {
				url,
				finalUrl: response.url,
				status: response.status,
				contentType: response.headers.get("content-type") ?? "",
				body: body.text,
				fetchMs: performance.now() - started,
			};
			if (response.ok) return { ...base, ok: true } satisfies FetchResult;
			const error = `HTTP ${response.status}`;
			return {
				...base,
				ok: false,
				error,
				failureKind: failureKind(response.status, error),
			} satisfies FetchResult;
		} catch (error) {
			if (attempt < 2 && !isTimeoutError(error)) {
				await Bun.sleep(retryDelayMs(attempt));
				continue;
			}
			return failed(
				url,
				currentUrl,
				0,
				started,
				error instanceof Error ? error.message : String(error),
			);
		}
	}
	return failed(url, currentUrl, 0, started, "fetch failed");
}

function isTimeoutError(error: unknown) {
	return (
		error instanceof Error &&
		(error.name === "TimeoutError" || /timed out|timeout/i.test(error.message))
	);
}

function refreshUrl(result: FetchResult): string | undefined {
	if (!result.ok || !/html/i.test(result.contentType)) return undefined;
	const match = result.body.match(
		/<meta\b[^>]*http-equiv=["']?\s*refresh\s*["']?[^>]*>/i,
	);
	if (!match) return undefined;
	const content = match[0].match(/\bcontent=["']([^"']+)["']/i)?.[1];
	const target = content?.match(/(?:^|;)\s*url\s*=\s*(.+)\s*$/i)?.[1]?.trim();
	if (!target) return undefined;
	try {
		const url = new URL(target.replace(/^['"]|['"]$/g, ""), result.finalUrl);
		url.hash = "";
		return url.href;
	} catch {
		return undefined;
	}
}

async function readBody(
	response: Response,
	url: string,
	started: number,
	config: Config,
): Promise<ReadBodyResult> {
	if (!response.body) {
		const body = new Uint8Array(await response.arrayBuffer());
		if (body.byteLength > config.maxBytes) {
			return {
				ok: false as const,
				result: tooLarge(url, response, started, config),
			};
		}
		return { ok: true as const, text: decodeBody(response, body) };
	}

	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let bytes = 0;

	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		bytes += value.byteLength;
		if (bytes > config.maxBytes) {
			await reader.cancel();
			return {
				ok: false as const,
				result: tooLarge(url, response, started, config),
			};
		}
		chunks.push(value);
	}

	const body = new Uint8Array(bytes);
	let offset = 0;
	for (const chunk of chunks) {
		body.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return { ok: true as const, text: decodeBody(response, body) };
}

function decodeBody(response: Response, body: Uint8Array): string {
	for (const encoding of charsetCandidates(response, body)) {
		try {
			return new TextDecoder(encoding, { fatal: true }).decode(body);
		} catch {}
	}
	return new TextDecoder().decode(body);
}

function charsetCandidates(response: Response, body: Uint8Array): string[] {
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
	return value
		?.trim()
		.replace(/^["']|["']$/g, "")
		.toLowerCase();
}

function tooLarge(
	url: string,
	response: Response,
	started: number,
	config: Config,
) {
	return failed(
		url,
		response.url,
		response.status,
		started,
		`response exceeds ${config.maxBytes} bytes`,
	);
}

type ReadBodyResult =
	| { ok: true; text: string }
	| { ok: false; result: FetchResult };

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
	if (status === 401 || status === 403 || status === 429) return "blocked";
	if (/exceeds/i.test(error)) return "too_large";
	if (/timeout|timed out|abort/i.test(error)) return "timeout";
	if (status > 0) return "http";
	return "fetch";
}
