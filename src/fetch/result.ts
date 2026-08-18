import type { FailureKind, FetchResult, RedirectHop } from "../core/types.ts";
import { isTooLargeError } from "./retry.ts";

export function failed(
	url: string,
	finalUrl: string,
	status: number,
	started: number,
	error: string,
	kind: FailureKind,
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
		error: normalizeFailureError(error),
		failureKind: kind,
	};
}

export function failureKind(status: number, _error: string): FailureKind {
	if (status === 404 || status === 410) return "not_found";
	if (status === 401 || status === 403 || status === 429) return "blocked";
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

export function emptyResourceResult(
	input: string | FetchResult,
	error: string,
): FetchResult {
	return failureResult(failureFields(input, true), error, "empty");
}

type FailedFetchFields = Omit<
	Extract<FetchResult, { ok: false }>,
	"ok" | "error" | "failureKind"
>;

export function filteredNonPageResult(
	input: FetchResult,
	defaultFetchedAt = false,
): FetchResult {
	const fields = { ...failureFields(input, true), body: input.body };
	if (!fields.fetchedAt && defaultFetchedAt) {
		fields.fetchedAt = new Date().toISOString();
	}
	return failureResult(
		fields,
		input.url !== input.finalUrl || input.redirects?.length
			? "redirected to a filtered non-page URL"
			: "filtered non-page URL",
		"blocked",
	);
}

function failureFields(
	input: string | FetchResult,
	includeValidators = false,
): FailedFetchFields {
	if (isUrl(input)) {
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
	const fields: FailedFetchFields = {
		url: input.url,
		finalUrl: input.finalUrl,
		redirects: input.redirects ?? [],
		status: input.status,
		contentType: input.contentType,
		body: "",
		fetchMs: input.fetchMs,
	};
	if (includeValidators && input.etag) fields.etag = input.etag;
	if (includeValidators && input.lastModified) {
		fields.lastModified = input.lastModified;
	}
	if (includeValidators && input.fetchedAt) fields.fetchedAt = input.fetchedAt;
	return fields;
}

function isUrl(input: string | FetchResult): input is string {
	return typeof input === "string";
}

function failureResult(
	fields: FailedFetchFields,
	error: string,
	failureKind: FailureKind,
): FetchResult {
	return { ...fields, ok: false, error, failureKind };
}
