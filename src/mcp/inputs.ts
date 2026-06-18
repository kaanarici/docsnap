import { resolvePriorOutputPath } from "../output/prior.ts";
import { assertSafeProjectRoot } from "./corpus.ts";
import { toolDefinitions } from "./definitions.ts";

// Validated argument parsers for every MCP tool. Type, range, length, enum,
// required, and unknown-field rejection are driven from each tool's published
// inputSchema in definitions.ts, so the wire schema and the runtime guard cannot
// drift (a maxLength declared for a client is also enforced here). Callers apply
// their own defaults: validated() returns only fields that were actually
// provided so absence-sensitive options — capture max_pages, which must stay
// unset to leave maxExplicit false for llms.txt corpora — are not forced.

type FetchScope = "page" | "site" | "auto";
type Freshness = "reuse" | "refresh" | "force";
type Safety = "exclude_injection" | "flag_all";

// The union of fields any tool can accept. Only the names and kinds live here;
// the bounds that actually gate them live in definitions.ts. enum fields are
// typed as their literal union because checkField rejects anything else.
type ValidatedInput = {
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

type PropSchema = {
	type: "string" | "integer" | "boolean";
	minimum?: number;
	maximum?: number;
	maxLength?: number;
	enum?: readonly string[];
};

type ToolSchema = {
	required?: string[];
	properties: Record<string, PropSchema>;
};

const schemas = new Map<string, ToolSchema>(
	toolDefinitions.map((tool) => [
		tool.name,
		tool.inputSchema as unknown as ToolSchema,
	]),
);

function validated(tool: string, value: unknown): ValidatedInput {
	const schema = schemas.get(tool);
	if (!schema) throw new Error(`Unknown tool: ${tool}`);
	const input =
		value && typeof value === "object" && !Array.isArray(value)
			? (value as Record<string, unknown>)
			: {};
	for (const key of Object.keys(input)) {
		if (!(key in schema.properties)) {
			throw new Error(`Unexpected input field: ${key}`);
		}
	}
	const out: Record<string, unknown> = {};
	for (const [key, prop] of Object.entries(schema.properties)) {
		if (!(key in input)) {
			if (schema.required?.includes(key)) throw new Error(`${key} is required`);
			continue;
		}
		out[key] = checkField(key, input[key], prop);
	}
	return out as ValidatedInput;
}

function checkField(key: string, raw: unknown, prop: PropSchema): unknown {
	if (prop.type === "boolean") {
		if (typeof raw !== "boolean") throw new Error(`${key} must be boolean`);
		return raw;
	}
	if (prop.type === "integer") {
		if (
			!Number.isInteger(raw) ||
			(prop.minimum !== undefined && (raw as number) < prop.minimum) ||
			(prop.maximum !== undefined && (raw as number) > prop.maximum)
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
		url: v.url as string,
		output_dir: v.output_dir,
		max_pages: v.max_pages,
		page_only: v.page_only ?? false,
		clean: v.clean ?? false,
		concurrency: v.concurrency,
	};
}

export function refreshInput(value: unknown) {
	const v = validated("docsnap_refresh", value);
	return {
		output_dir: v.output_dir as string,
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
		output_dir: v.output_dir as string,
		include_errors: v.include_errors ?? true,
		include_refresh_changes: v.include_refresh_changes ?? true,
		error_limit: v.error_limit ?? 10,
	};
}

export function pagesInput(value: unknown) {
	const v = validated("docsnap_list_pages", value);
	return {
		output_dir: v.output_dir as string,
		page_size: v.page_size ?? 50,
		cursor: cursorOf(v.cursor),
		include_failures: v.include_failures ?? false,
	};
}

export function searchInput(value: unknown) {
	const v = validated("docsnap_search_corpus", value);
	return {
		output_dir: v.output_dir as string,
		query: v.query as string,
		path_glob: pathGlobOf(v.path_glob),
		max_results: v.max_results ?? 10,
		snippet_chars: v.snippet_chars ?? 350,
		safety: v.safety ?? "flag_all",
	};
}

export function readPageInput(value: unknown) {
	const v = validated("docsnap_read_page", value);
	const output = v.output_dir as string;
	const path = v.output_path as string;
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
};

export function fetchInput(value: unknown): FetchToolInput {
	const v = validated("docsnap_fetch", value);
	return {
		url: v.url as string,
		...(v.question !== undefined ? { question: v.question } : {}),
		...(v.scope !== undefined ? { scope: v.scope } : {}),
		...(v.output_dir !== undefined ? { output_dir: v.output_dir } : {}),
		...(v.max_pages !== undefined ? { max_pages: v.max_pages } : {}),
		freshness: v.freshness ?? "reuse",
		context_chars: v.context_chars ?? 500,
		safety: v.safety ?? "flag_all",
	};
}

export function contextPackInput(value: unknown) {
	const v = validated("docsnap_context_pack", value);
	return {
		output_dir: v.output_dir as string,
		query: v.query as string,
		max_snippets: v.max_snippets ?? 8,
		context_chars: v.context_chars ?? 500,
		path_glob: pathGlobOf(v.path_glob),
		safety: v.safety ?? "flag_all",
	};
}
