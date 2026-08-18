import type { FetchResult } from "../core/types.ts";

const defaultFreshMs = 6 * 60 * 60 * 1000;
const maxFreshMs = 24 * 60 * 60 * 1000;

export function freshUntilFor(result: FetchResult): Date | undefined {
	if (!cacheableResponse(result)) return undefined;
	const now = Date.now();
	const ageMs = (result.ageSeconds ?? 0) * 1000;
	const cacheControl = result.cacheControl?.toLowerCase();
	if (cacheControl) {
		// docsnap's cache is shared across output dirs, so honor s-maxage over
		// max-age regardless of header order (RFC 7234 shared-cache semantics).
		const directives = parseCacheControl(cacheControl);
		const maxAge = directives.get("s-maxage") ?? directives.get("max-age");
		if (maxAge !== undefined && /^\d+$/.test(maxAge)) {
			return freshUntil(now, Number(maxAge) * 1000, ageMs);
		}
		return undefined;
	}
	if (/text\/html|text\/plain|markdown|mdx/i.test(result.contentType)) {
		return freshUntil(now, defaultFreshMs, ageMs);
	}
	return undefined;
}

function freshUntil(now: number, ttlMs: number, ageMs: number) {
	const remainingMs = Math.min(ttlMs, maxFreshMs) - ageMs;
	return remainingMs > 0 ? new Date(now + remainingMs) : undefined;
}

function parseCacheControl(value: string): Map<string, string> {
	const directives = new Map<string, string>();
	for (const part of value.split(",")) {
		const [name, ...rest] = part.trim().split("=");
		const key = name?.trim();
		if (key && !directives.has(key)) directives.set(key, rest.join("=").trim());
	}
	return directives;
}

function cacheableResponse(result: FetchResult): boolean {
	if (!result.ok || isNotModifiedResult(result)) return false;
	if (result.document) return false;
	if (result.status < 200 || result.status > 299) return false;
	if (result.setCookie) return false;
	if (hasAnyDirective(result.cacheControl, ["no-store", "no-cache", "private"]))
		return false;
	return !hasAnyDirective(result.vary, ["*", "cookie", "authorization"]);
}

function hasAnyDirective(
	value: string | undefined,
	blocked: readonly string[],
): boolean {
	return Boolean(
		value
			?.split(",")
			.some((part) =>
				blocked.includes(part.trim().split("=", 1)[0]?.toLowerCase() ?? ""),
			),
	);
}

export function isNotModifiedResult(
	result: FetchResult,
): result is FetchResult & { ok: true; notModified: true } {
	return result.ok && "notModified" in result && result.notModified === true;
}
