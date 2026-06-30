import { resolvePriorOutputPath } from "../output/prior.ts";
import { type ToolInputSchema, toolDefinitions } from "./definitions.ts";
import { assertSafeProjectRoot } from "./scan.ts";

// Runtime guards come from the published MCP schemas; absent fields stay absent
// so max_pages does not force maxExplicit.

type FetchScope = "page" | "site" | "auto";
type Freshness = "auto" | "reuse" | "refresh" | "force";
type Safety = "exclude_injection" | "flag_all";
type ValidatedValue = string | number | boolean;

type ValidatedInput = Record<string, ValidatedValue | undefined> & {
	url?: string;
	output_dir?: string;
	output_path?: string;
	root_dir?: string;
	query?: string;
	question?: string;
	cursor?: string;
	path_glob?: string;
	scope?: FetchScope;
	freshness?: Freshness;
	safety?: Safety;
	max_pages?: number;
	concurrency?: number;
	page_size?: number;
	error_limit?: number;
	max_results?: number;
	snippet_chars?: number;
	start_line?: number;
	end_line?: number;
	max_chars?: number;
	max_snippets?: number;
	context_chars?: number;
	page_only?: boolean;
	clean?: boolean;
	include_errors?: boolean;
	include_refresh_changes?: boolean;
	include_failures?: boolean;
	include_frontmatter?: boolean;
};

const schemas = new Map<string, ToolInputSchema>(
	toolDefinitions.map((tool) => [tool.name, tool.inputSchema]),
);

function validated(tool: string, value: unknown): ValidatedInput {
	const schema = schemas.get(tool);
	if (!schema) throw new Error(`Unknown tool: ${tool}`);
	const input = recordInput(value);
	for (const key of Object.keys(input)) {
		if (!(key in schema.properties)) {
			throw new Error(`Unexpected input field: ${key}`);
		}
	}
	const out: ValidatedInput = {};
	for (const [key, prop] of Object.entries(schema.properties)) {
		if (!(key in input)) {
			if (schema.required?.includes(key)) throw new Error(`${key} is required`);
			continue;
		}
		out[key] = checkField(key, input[key], prop);
	}
	return out;
}

function recordInput(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return {};
	return Object.fromEntries(Object.entries(value));
}

function checkField(
	key: string,
	raw: unknown,
	prop: ToolInputSchema["properties"][string],
): ValidatedValue {
	if (prop.type === "boolean") {
		if (typeof raw !== "boolean") throw new Error(`${key} must be boolean`);
		return raw;
	}
	if (prop.type === "integer") {
		if (
			typeof raw !== "number" ||
			!Number.isInteger(raw) ||
			(prop.minimum !== undefined && raw < prop.minimum) ||
			(prop.maximum !== undefined && raw > prop.maximum)
		) {
			throw new Error(
				`${key} must be an integer from ${prop.minimum} to ${prop.maximum}`,
			);
		}
		return raw;
	}
	if (typeof raw !== "string" || raw.trim() === "" || raw.includes("\0")) {
		throw new Error(`${key} must be a non-empty string`);
	}
	if (prop.maxLength !== undefined && raw.length > prop.maxLength) {
		throw new Error(`${key} must be ${prop.maxLength} characters or fewer`);
	}
	if (prop.enum && !prop.enum.includes(raw)) {
		throw new Error(`${key} must be one of: ${prop.enum.join(", ")}`);
	}
	return raw;
}

function required<T>(value: T | undefined, key: string): T {
	if (value === undefined) throw new Error(`${key} is required`);
	return value;
}

function pathGlobOf(glob: string | undefined): string | undefined {
	if (glob === undefined) return undefined;
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

function cursorOf(cursor: string | undefined): string | undefined {
	if (cursor === undefined) return undefined;
	if (!/^\d{1,8}$/.test(cursor)) {
		throw new Error("cursor must be a pagination token returned by docsnap");
	}
	return cursor;
}

export function captureInput(value: unknown) {
	const v = validated("docsnap_capture", value);
	return {
		url: required(v.url, "url"),
		output_dir: v.output_dir,
		max_pages: v.max_pages,
		page_only: v.page_only === true ? true : undefined,
		clean: v.clean ?? false,
		concurrency: v.concurrency,
	};
}

export function refreshInput(value: unknown) {
	const v = validated("docsnap_refresh", value);
	return {
		output_dir: required(v.output_dir, "output_dir"),
		max_pages: v.max_pages,
		concurrency: v.concurrency,
	};
}

export function corporaInput(value: unknown) {
	const v = validated("docsnap_list_corpora", value);
	const rootDir = v.root_dir ?? "docsnap";
	assertSafeProjectRoot(rootDir);
	return {
		root_dir: rootDir,
		page_size: v.page_size ?? 25,
		cursor: cursorOf(v.cursor),
	};
}

export function summaryInput(value: unknown) {
	const v = validated("docsnap_get_corpus_summary", value);
	return {
		output_dir: required(v.output_dir, "output_dir"),
		include_errors: v.include_errors ?? true,
		include_refresh_changes: v.include_refresh_changes ?? true,
		error_limit: v.error_limit ?? 10,
	};
}

export function pagesInput(value: unknown) {
	const v = validated("docsnap_list_pages", value);
	return {
		output_dir: required(v.output_dir, "output_dir"),
		page_size: v.page_size ?? 50,
		cursor: cursorOf(v.cursor),
		include_failures: v.include_failures ?? false,
	};
}

export function searchInput(value: unknown) {
	const v = validated("docsnap_search_corpus", value);
	return {
		output_dir: required(v.output_dir, "output_dir"),
		query: required(v.query, "query"),
		path_glob: pathGlobOf(v.path_glob),
		max_results: v.max_results ?? 10,
		snippet_chars: v.snippet_chars ?? 350,
		safety: v.safety ?? "flag_all",
	};
}

export function readPageInput(value: unknown) {
	const v = validated("docsnap_read_page", value);
	const output = required(v.output_dir, "output_dir");
	const path = required(v.output_path, "output_path");
	if (!resolvePriorOutputPath({ outDir: output }, path)) {
		throw new Error("output_path must be a safe relative manifest path");
	}
	const startLine = v.start_line ?? 1;
	const endLine = v.end_line;
	if (endLine !== undefined && endLine < startLine) {
		throw new Error("end_line must be greater than or equal to start_line");
	}
	return {
		output_dir: output,
		output_path: path,
		start_line: startLine,
		end_line: endLine,
		max_chars: v.max_chars ?? 12_000,
		include_frontmatter: v.include_frontmatter ?? true,
	};
}

export type FetchToolInput = {
	url: string;
	question?: string;
	scope?: FetchScope;
	output_dir?: string;
	max_pages?: number;
	freshness: Freshness;
	context_chars: number;
	safety: Safety;
	cache?: boolean;
};

export function fetchInput(value: unknown): FetchToolInput {
	const v = validated("docsnap_fetch", value);
	return {
		url: required(v.url, "url"),
		...(v.question !== undefined ? { question: v.question } : {}),
		...(v.scope !== undefined ? { scope: v.scope } : {}),
		...(v.output_dir !== undefined ? { output_dir: v.output_dir } : {}),
		...(v.max_pages !== undefined ? { max_pages: v.max_pages } : {}),
		freshness: v.freshness ?? "auto",
		context_chars: v.context_chars ?? 500,
		safety: v.safety ?? "flag_all",
	};
}

export function contextPackInput(value: unknown) {
	const v = validated("docsnap_context_pack", value);
	return {
		output_dir: required(v.output_dir, "output_dir"),
		query: required(v.query, "query"),
		max_snippets: v.max_snippets ?? 8,
		context_chars: v.context_chars ?? 500,
		path_glob: pathGlobOf(v.path_glob),
		safety: v.safety ?? "flag_all",
	};
}
