import { resolvePriorOutputPath } from "../output/prior.ts";
import { assertSafeProjectRoot } from "./corpus.ts";

// Validated argument parsers for every MCP tool. Each rejects unknown fields and
// enforces type/range bounds so untrusted JSON-RPC input cannot reach the
// pipeline or filesystem without passing a strict allowlist.

type ObjectInput = Record<string, unknown>;

export function captureInput(value: unknown) {
	const input = objectInput(value, [
		"url",
		"output_dir",
		"max_pages",
		"page_only",
		"clean",
		"concurrency",
	]);
	return {
		url: stringInput(input, "url"),
		output_dir: optionalString(input, "output_dir"),
		max_pages: optionalInt(input, "max_pages", 1, 500),
		page_only: optionalBool(input, "page_only", false),
		clean: optionalBool(input, "clean", false),
		concurrency: optionalInt(input, "concurrency", 1, 64),
	};
}

export function refreshInput(value: unknown) {
	const input = objectInput(value, ["output_dir", "max_pages", "concurrency"]);
	return {
		output_dir: stringInput(input, "output_dir"),
		max_pages: optionalInt(input, "max_pages", 1, 500),
		concurrency: optionalInt(input, "concurrency", 1, 64),
	};
}

export function corporaInput(value: unknown) {
	const input = objectInput(value, ["root_dir", "page_size", "cursor"]);
	const rootDir = optionalString(input, "root_dir") ?? "docsnap";
	assertSafeProjectRoot(rootDir);
	return {
		root_dir: rootDir,
		page_size: optionalInt(input, "page_size", 1, 100) ?? 25,
		cursor: optionalCursor(input),
	};
}

export function summaryInput(value: unknown) {
	const input = objectInput(value, [
		"output_dir",
		"include_errors",
		"include_refresh_changes",
		"error_limit",
	]);
	return {
		output_dir: stringInput(input, "output_dir"),
		include_errors: optionalBool(input, "include_errors", true),
		include_refresh_changes: optionalBool(
			input,
			"include_refresh_changes",
			true,
		),
		error_limit: optionalInt(input, "error_limit", 0, 100) ?? 10,
	};
}

export function pagesInput(value: unknown) {
	const input = objectInput(value, [
		"output_dir",
		"page_size",
		"cursor",
		"include_failures",
	]);
	return {
		output_dir: stringInput(input, "output_dir"),
		page_size: optionalInt(input, "page_size", 1, 200) ?? 50,
		cursor: optionalCursor(input),
		include_failures: optionalBool(input, "include_failures", false),
	};
}

export function searchInput(value: unknown) {
	const input = objectInput(value, [
		"output_dir",
		"query",
		"path_glob",
		"max_results",
		"snippet_chars",
		"safety",
	]);
	return {
		output_dir: stringInput(input, "output_dir"),
		query: stringInput(input, "query"),
		path_glob: optionalPathGlob(input),
		max_results: optionalInt(input, "max_results", 1, 50) ?? 10,
		snippet_chars: optionalInt(input, "snippet_chars", 120, 1200) ?? 350,
		safety: optionalSafety(input),
	};
}

export function readPageInput(value: unknown) {
	const input = objectInput(value, [
		"output_dir",
		"output_path",
		"start_line",
		"end_line",
		"max_chars",
		"include_frontmatter",
	]);
	const output = stringInput(input, "output_dir");
	const path = stringInput(input, "output_path");
	if (!resolvePriorOutputPath({ outDir: output }, path)) {
		throw new Error("output_path must be a safe relative manifest path");
	}
	const startLine = optionalInt(input, "start_line", 1, 1_000_000) ?? 1;
	const endLine = optionalInt(input, "end_line", 1, 1_000_000);
	if (endLine !== undefined && endLine < startLine) {
		throw new Error("end_line must be greater than or equal to start_line");
	}
	return {
		output_dir: output,
		output_path: path,
		start_line: startLine,
		end_line: endLine,
		max_chars: optionalInt(input, "max_chars", 500, 25_000) ?? 12_000,
		include_frontmatter: optionalBool(input, "include_frontmatter", true),
	};
}

export type FetchToolInput = {
	url: string;
	question?: string;
	scope?: "page" | "site" | "auto";
	output_dir?: string;
	max_pages?: number;
	freshness: "reuse" | "refresh" | "force";
	context_chars: number;
	safety: "exclude_injection" | "flag_all";
};

export function fetchInput(value: unknown): FetchToolInput {
	const input = objectInput(value, [
		"url",
		"question",
		"scope",
		"output_dir",
		"max_pages",
		"freshness",
		"context_chars",
		"safety",
	]);
	const question = optionalString(input, "question");
	if (question !== undefined && question.length > 500) {
		throw new Error("question must be 500 characters or fewer");
	}
	const outputDir = optionalString(input, "output_dir");
	const maxPages = optionalInt(input, "max_pages", 1, 500);
	return {
		url: stringInput(input, "url"),
		...(question !== undefined ? { question } : {}),
		...("scope" in input ? { scope: optionalScope(input) } : {}),
		...(outputDir !== undefined ? { output_dir: outputDir } : {}),
		...(maxPages !== undefined ? { max_pages: maxPages } : {}),
		freshness: optionalFreshness(input),
		context_chars: optionalInt(input, "context_chars", 120, 1200) ?? 500,
		safety: optionalSafety(input),
	};
}

function optionalScope(input: ObjectInput): "page" | "site" | "auto" {
	const value = optionalString(input, "scope") ?? "auto";
	if (value !== "page" && value !== "site" && value !== "auto") {
		throw new Error('scope must be "page", "site", or "auto"');
	}
	return value;
}

function optionalFreshness(input: ObjectInput): "reuse" | "refresh" | "force" {
	const value = optionalString(input, "freshness") ?? "reuse";
	if (value !== "reuse" && value !== "refresh" && value !== "force") {
		throw new Error('freshness must be "reuse", "refresh", or "force"');
	}
	return value;
}

export function contextPackInput(value: unknown) {
	const input = objectInput(value, [
		"output_dir",
		"query",
		"max_snippets",
		"context_chars",
		"path_glob",
		"safety",
	]);
	const output = stringInput(input, "output_dir");
	const query = stringInput(input, "query");
	if (query.length > 500) {
		throw new Error("query must be 500 characters or fewer");
	}
	return {
		output_dir: output,
		query,
		max_snippets: optionalInt(input, "max_snippets", 1, 25) ?? 8,
		context_chars: optionalInt(input, "context_chars", 120, 1200) ?? 500,
		path_glob: optionalPathGlob(input),
		safety: optionalSafety(input),
	};
}

function optionalSafety(input: ObjectInput): "exclude_injection" | "flag_all" {
	const value = optionalString(input, "safety") ?? "flag_all";
	if (value !== "exclude_injection" && value !== "flag_all") {
		throw new Error('safety must be "exclude_injection" or "flag_all"');
	}
	return value;
}

function objectInput(value: unknown, allowed: string[]): ObjectInput {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return {};
	}
	const input = value as ObjectInput;
	for (const key of Object.keys(input)) {
		if (!allowed.includes(key)) {
			throw new Error(`Unexpected input field: ${key}`);
		}
	}
	return input;
}

function stringInput(input: ObjectInput, key: string): string {
	const value = input[key];
	if (
		typeof value !== "string" ||
		value.trim() === "" ||
		value.includes("\0")
	) {
		throw new Error(`${key} must be a non-empty string`);
	}
	return value;
}

function optionalString(input: ObjectInput, key: string): string | undefined {
	if (!(key in input)) return undefined;
	return stringInput(input, key);
}

function optionalInt(
	input: ObjectInput,
	key: string,
	min: number,
	max: number,
): number | undefined {
	if (!(key in input)) return undefined;
	const value = input[key];
	if (
		!Number.isInteger(value) ||
		(value as number) < min ||
		(value as number) > max
	) {
		throw new Error(`${key} must be an integer from ${min} to ${max}`);
	}
	return value as number;
}

function optionalBool(
	input: ObjectInput,
	key: string,
	fallback: boolean,
): boolean {
	if (!(key in input)) return fallback;
	if (typeof input[key] !== "boolean") {
		throw new Error(`${key} must be boolean`);
	}
	return input[key];
}

function optionalCursor(input: ObjectInput): string | undefined {
	const cursor = optionalString(input, "cursor");
	if (cursor !== undefined && !/^\d{1,8}$/.test(cursor)) {
		throw new Error("cursor must be a pagination token returned by docsnap");
	}
	return cursor;
}

function optionalPathGlob(input: ObjectInput): string | undefined {
	const glob = optionalString(input, "path_glob");
	if (!glob) return undefined;
	if (
		glob.length > 200 ||
		glob.startsWith("/") ||
		/^[a-zA-Z]:[\\/]/.test(glob) ||
		glob.split(/[\\/]+/).includes("..")
	) {
		throw new Error("path_glob must be a simple relative glob");
	}
	return glob;
}
