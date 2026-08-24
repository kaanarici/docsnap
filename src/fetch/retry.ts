import type { FailureKind } from "../core/types.ts";

const refusedErrorPattern = /ECONNREFUSED/i;
const unsafeUrlErrorPattern =
	/private|internal|localhost|single-label|credentials|unsafe|scheme|resolve/i;

export function retryDelayMs(
	attempt: number,
	retryAfter?: string | null,
): number {
	if (retryAfter) {
		const seconds = Number(retryAfter);
		if (Number.isFinite(seconds)) return Math.min(seconds * 1000, 10_000);
		const date = Date.parse(retryAfter);
		if (Number.isFinite(date))
			return Math.min(Math.max(0, date - Date.now()), 10_000);
	}
	return Math.min(250 * 2 ** attempt + Math.floor(Math.random() * 80), 2500);
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
		!isUnsafeUrlError(cause.message)
	);
}

export function isTooLargeError(error: string): boolean {
	return /response exceeds|buffer larger than|maxOutputLength/i.test(error);
}

export function isUnsafeUrlError(error: string): boolean {
	return unsafeUrlErrorPattern.test(error);
}

export function thrownFetchKind(cause: unknown): FailureKind {
	if (isTimeoutError(cause)) return "timeout";
	const error = cause instanceof Error ? cause.message : String(cause);
	if (isTooLargeError(error)) return "too_large";
	if (isUnsafeUrlError(error)) return "unsafe_url";
	return "fetch";
}

function isTimeoutError(cause: unknown) {
	return (
		cause instanceof Error &&
		(cause.name === "TimeoutError" ||
			/timed out|timeout/i.test(`${cause.name} ${cause.message}`))
	);
}
