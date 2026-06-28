import type { FailureKind, FetchResult, RedirectHop } from "../core/types.ts";
import { isTooLargeError, isUnsafeUrlError } from "./retry.ts";

export function failed(
	url: string,
	finalUrl: string,
	status: number,
	started: number,
	error: string,
	redirects: RedirectHop[] = [],
): FetchResult {
	const normalizedError = normalizeFailureError(error);
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
		error: normalizedError,
		failureKind: failureKind(status, normalizedError),
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

function normalizeFailureError(error: string): string {
	if (/response exceeds \d+ bytes/i.test(error)) return error;
	const maxBytes = error.match(/buffer larger than (\d+) bytes/i)?.[1];
	if (maxBytes) return `response exceeds ${maxBytes} bytes`;
	return isTooLargeError(error)
		? "response exceeds configured byte limit"
		: error;
}

export function robotsBlockedResult(input: string | FetchResult): FetchResult {
	return failureResult(
		failureFields(input),
		"blocked by robots.txt",
		"blocked",
	);
}

export function emptyResourceResult(
	input: string | FetchResult,
	error: string,
): FetchResult {
	return failureResult(failureFields(input, true), error, "empty");
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
	const redirected =
		url !== finalUrl ||
		(options.redirects !== undefined && options.redirects.length > 0);
	return failureResult(
		{
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
		},
		redirected
			? "redirected to a filtered non-page URL"
			: "filtered non-page URL",
		"blocked",
	);
}

type FailedFetchFields = Omit<
	Extract<FetchResult, { ok: false }>,
	"ok" | "error" | "failureKind"
>;

function failureFields(
	input: string | FetchResult,
	includeValidators = false,
): FailedFetchFields {
	if (typeof input === "string") {
		return {
			url: input,
			finalUrl: input,
			redirects: [],
			status: 0,
			contentType: "",
			body: "",
			fetchMs: 0,
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
		...(includeValidators && input.etag ? { etag: input.etag } : {}),
		...(includeValidators && input.lastModified
			? { lastModified: input.lastModified }
			: {}),
		...(includeValidators && input.fetchedAt
			? { fetchedAt: input.fetchedAt }
			: {}),
	};
}

function failureResult(
	fields: FailedFetchFields,
	error: string,
	failureKind: FailureKind,
): FetchResult {
	return { ...fields, ok: false, error, failureKind };
}
