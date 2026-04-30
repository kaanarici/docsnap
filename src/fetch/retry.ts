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

export function shouldRetry(status: number): boolean {
	return status === 429 || status >= 500;
}
