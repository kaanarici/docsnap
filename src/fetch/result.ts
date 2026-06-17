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
	// an explicit robots/challenge block wins over the upstream status: a route
	// fallback denied by robots can carry the original 404, but the real cause is
	// "do not fetch", not "stale URL"
	if (/blocked|challenge/i.test(error)) return "blocked";
	if (status === 404 || status === 410) return "not_found";
	if ([401, 403, 429].includes(status)) return "blocked";
	if (/exceeds/i.test(error)) return "too_large";
	if (isUnsafeUrlError(error)) return "unsafe_url";
	if (/timeout|timed out|abort/i.test(error)) return "timeout";
	if (status > 0) return "http";
	return "fetch";
}

export function robotsBlockedResult(input: string | FetchResult): FetchResult {
	if (typeof input === "string") {
		return {
			url: input,
			finalUrl: input,
			redirects: [],
			status: 0,
			contentType: "",
			body: "",
			fetchMs: 0,
			ok: false,
			error: "blocked by robots.txt",
			failureKind: "blocked",
		};
	}
	return {
		url: input.url,
		finalUrl: input.finalUrl,
		redirects: input.redirects ?? [],
		status: input.status,
		contentType: input.contentType,
		body: "",
		fetchMs: input.fetchMs,
		ok: false,
		error: "blocked by robots.txt",
		failureKind: "blocked",
	};
}

type FilteredNonPageOptions = {
	redirects?: RedirectHop[];
	status: number;
	contentType: string;
	body: string;
	fetchMs: number;
	etag?: string;
	lastModified?: string;
	fetchedAt?: string;
	defaultFetchedAt?: boolean;
};

export function filteredNonPageResult(
	url: string,
	finalUrl: string,
	options: FilteredNonPageOptions,
): FetchResult {
	return {
		url,
		finalUrl,
		redirects: options.redirects ?? [],
		status: options.status,
		contentType: options.contentType,
		body: options.body,
		fetchMs: options.fetchMs,
		...(options.etag ? { etag: options.etag } : {}),
		...(options.lastModified ? { lastModified: options.lastModified } : {}),
		...(options.fetchedAt || options.defaultFetchedAt
			? { fetchedAt: options.fetchedAt ?? new Date().toISOString() }
			: {}),
		ok: false,
		error: "redirected to a filtered non-page URL",
		failureKind: "blocked",
	};
}
