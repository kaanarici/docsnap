import type { FailureKind, FetchResult, RedirectHop } from "../core/types.ts";
import { isUnsafeUrlError } from "./retry.ts";

export function failed(
	url: string,
	finalUrl: string,
	status: number,
	started: number,
	error: string,
	redirects: RedirectHop[] = [],
): FetchResult {
	return {
		url,
		finalUrl,
		status,
		contentType: "",
		body: "",
		ok: false,
		fetchMs: performance.now() - started,
		redirects,
		fetchedAt: new Date().toISOString(),
		error,
		failureKind: failureKind(status, error),
	};
}

export function failureKind(status: number, error: string): FailureKind {
	if (status === 404 || status === 410) return "not_found";
	if ([401, 403, 429].includes(status) || /blocked|challenge/i.test(error))
		return "blocked";
	if (/exceeds/i.test(error)) return "too_large";
	if (isUnsafeUrlError(error)) return "unsafe_url";
	if (/timeout|timed out|abort/i.test(error)) return "timeout";
	if (status > 0) return "http";
	return "fetch";
}
