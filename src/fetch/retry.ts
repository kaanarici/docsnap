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

export function shouldRetry(
	status: number,
	attempt: number,
	enabled: boolean,
): boolean {
	return enabled && attempt < 2 && (status === 429 || status >= 500);
}

export function isRetryableFetchError(error: unknown): boolean {
	return (
		error instanceof Error &&
		!isTimeoutError(error) &&
		!refusedErrorPattern.test(error.message) &&
		!isUnsafeUrlError(error.message)
	);
}

export function isUnsafeUrlError(error: string): boolean {
	return unsafeUrlErrorPattern.test(error);
}

function isTimeoutError(error: unknown) {
	return (
		error instanceof Error &&
		/timed out|timeout/i.test(`${error.name} ${error.message}`)
	);
}
