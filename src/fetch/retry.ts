import type { FailureKind } from "../core/types.ts";
import { UnsafeUrlError } from "../security/url.ts";

const refusedErrorPattern = /ECONNREFUSED/i;

export function retryDelayMs(
	attempt: number,
	retryAfter?: string | null,
	now = Date.now(),
): number {
	const retryAt = retryAtMs(retryAfter, now);
	if (retryAt !== undefined) {
		return Math.min(Math.max(0, retryAt - now), 10_000);
	}
	return Math.min(250 * 2 ** attempt + Math.floor(Math.random() * 80), 2500);
}

export function retryAtFromHeader(
	retryAfter?: string | null,
	now = Date.now(),
): string | undefined {
	const retryAt = retryAtMs(retryAfter, now);
	return retryAt === undefined ? undefined : new Date(retryAt).toISOString();
}

function retryAtMs(retryAfter: string | null | undefined, now: number) {
	const value = retryAfter?.trim();
	if (!value) return;
	const seconds = Number(value);
	if (Number.isFinite(seconds)) {
		if (!Number.isSafeInteger(seconds) || seconds < 0) return;
		const retryAt = now + seconds * 1000;
		return Number.isFinite(retryAt) && retryAt <= 8.64e15 ? retryAt : undefined;
	}
	const retryAt = Date.parse(value);
	return Number.isFinite(retryAt) ? retryAt : undefined;
}

export function shouldRetry(status: number, attempt: number): boolean {
	return attempt < 2 && (status === 429 || status >= 500);
}

export function isRetryableFetchError(cause: unknown): boolean {
	return (
		cause instanceof Error &&
		!isTimeoutError(cause) &&
		!refusedErrorPattern.test(cause.message) &&
		!isTooLargeError(cause.message) &&
		!(cause instanceof UnsafeUrlError)
	);
}

export function isTooLargeError(error: string): boolean {
	return /response exceeds|buffer larger than|maxOutputLength/i.test(error);
}

export function thrownFetchKind(cause: unknown): FailureKind {
	if (isTimeoutError(cause)) return "timeout";
	if (cause instanceof UnsafeUrlError) return "unsafe_url";
	const error = cause instanceof Error ? cause.message : String(cause);
	if (isTooLargeError(error)) return "too_large";
	return "fetch";
}

function isTimeoutError(cause: unknown) {
	return (
		cause instanceof Error &&
		(cause.name === "TimeoutError" ||
			/timed out|timeout/i.test(`${cause.name} ${cause.message}`))
	);
}
