import { parseArgs } from "../cli/args.ts";
import { runPipeline } from "../core/pipeline.ts";
import type { Config } from "../core/types.ts";
import { resolvePriorOutputPath } from "../output/prior.ts";
import { type McpState, readableCorpusDir, rememberCorpus } from "./access.ts";
import {
	assertSafeProjectRoot,
	getCorpusSummary,
	listCorpora,
	listPages,
	readPageSlice,
	readSummary,
	searchCorpus,
} from "./corpus.ts";
import { exampleFor, toolDefinitions } from "./definitions.ts";
import {
	captureResult,
	errorToolResult,
	frameWebContent,
	jsonToolResult,
	refreshResult,
	type ToolResult,
} from "./results.ts";

type ObjectInput = Record<string, unknown>;

export function listTools() {
	return { tools: toolDefinitions };
}

export async function callTool(
	name: string,
	args: unknown,
	state: McpState,
): Promise<ToolResult> {
	try {
		if (name === "docsnap_capture") return await capture(args, state);
		if (name === "docsnap_refresh") return await refresh(args, state);
		if (name === "docsnap_list_corpora") return await corpora(args, state);
		if (name === "docsnap_get_corpus_summary")
			return await corpusSummary(args, state);
		if (name === "docsnap_list_pages") return await pages(args, state);
		if (name === "docsnap_search_corpus") return await search(args, state);
		if (name === "docsnap_read_page") return await readPage(args, state);
		throw new Error(`Unknown tool: ${name}`);
	} catch (error) {
		return errorToolResult(name, error, exampleFor(name));
	}
}

async function capture(args: unknown, state: McpState) {
	const input = captureInput(args);
	const result = await runPipeline(configForCapture(input), stderrProgress);
	rememberCorpus(state, result.summary.outDir);
	return jsonToolResult(captureResult(result.summary));
}

async function refresh(args: unknown, state: McpState) {
	const input = refreshInput(args);
	const prior = await readSummary(input.output_dir);
	const config = configForRefresh(
		input,
		prior.max,
		prior.maxAppliesTo,
		prior.seedUrl,
	);
	const result = await runPipeline(config, stderrProgress);
	rememberCorpus(state, result.summary.outDir);
	return jsonToolResult(refreshResult(result.summary));
}

async function corpora(args: unknown, state: McpState) {
	const input = corporaInput(args);
	return jsonToolResult(
		await listCorpora(
			input.root_dir,
			input.page_size,
			input.cursor,
			state.corpora,
		),
	);
}

async function corpusSummary(args: unknown, state: McpState) {
	const input = summaryInput(args);
	const outputDir = await readableCorpusDir(input.output_dir, state.corpora);
	return jsonToolResult(
		await getCorpusSummary(outputDir, {
			includeErrors: input.include_errors,
			includeRefreshChanges: input.include_refresh_changes,
			errorLimit: input.error_limit,
		}),
	);
}

async function pages(args: unknown, state: McpState) {
	const input = pagesInput(args);
	const outputDir = await readableCorpusDir(input.output_dir, state.corpora);
	return jsonToolResult(
		await listPages(
			outputDir,
			input.page_size,
			input.cursor,
			input.include_failures,
		),
	);
}

async function search(args: unknown, state: McpState) {
	const input = searchInput(args);
	const outputDir = await readableCorpusDir(input.output_dir, state.corpora);
	const result = await searchCorpus(outputDir, {
		query: input.query,
		...(input.path_glob ? { pathGlob: input.path_glob } : {}),
		maxResults: input.max_results,
		snippetChars: input.snippet_chars,
	});
	return jsonToolResult({
		query: input.query,
		matches: result.matches.map((match) => ({
			output_path: match.record.outputPath,
			url: match.record.url,
			...(match.record.title
				? { untrusted_web_title: match.record.title }
				: {}),
			line_start: match.lineStart,
			line_end: match.lineEnd,
			snippet: frameWebContent({
				sourceUrl: match.record.url,
				corpusPath: `${outputDir}/${match.record.outputPath}`,
				injectionSignals: match.record.injectionSignals,
				body: match.text,
			}),
			untrusted_web_content: true,
		})),
		truncated: result.truncated,
	});
}

async function readPage(args: unknown, state: McpState) {
	const input = readPageInput(args);
	const outputDir = await readableCorpusDir(input.output_dir, state.corpora);
	const page = await readPageSlice(
		outputDir,
		input.output_path,
		input.start_line,
		input.max_chars,
		input.include_frontmatter,
	);
	return jsonToolResult({
		page: {
			output_path: input.output_path,
			url: page.record.url,
			final_url: page.record.finalUrl,
			...(page.record.title ? { untrusted_web_title: page.record.title } : {}),
			start_line: page.startLine,
			end_line: page.endLine,
			truncated: page.truncated,
			untrusted_web_content: true,
		},
		text: frameWebContent({
			sourceUrl: page.record.url,
			corpusPath: `${outputDir}/${input.output_path}`,
			injectionSignals: page.record.injectionSignals,
			body: page.text,
			truncated: page.truncated,
		}),
	});
}

function configForCapture(input: ReturnType<typeof captureInput>): Config {
	const argv = [input.url];
	if (input.output_dir) argv.push("-o", input.output_dir);
	if (input.max_pages !== undefined) argv.push("-m", String(input.max_pages));
	if (input.page_only) argv.push("--page");
	if (input.clean) argv.push("--clean");
	if (input.concurrency !== undefined) {
		argv.push("--concurrency", String(input.concurrency));
	}
	return controlledConfig(argv);
}

function configForRefresh(
	input: ReturnType<typeof refreshInput>,
	priorMax: number,
	maxAppliesTo: "all" | "non-llms",
	seedUrl: string,
): Config {
	const config = controlledConfig([seedUrl, "-o", input.output_dir]);
	config.max = input.max_pages ?? priorMax;
	config.maxExplicit =
		input.max_pages !== undefined ? true : maxAppliesTo === "all";
	if (input.concurrency !== undefined) {
		config.concurrency = input.concurrency;
		config.perOrigin = Math.min(config.concurrency, config.perOrigin);
	}
	return config;
}

function controlledConfig(argv: string[]): Config {
	const parsed = parseArgs(argv);
	if ("help" in parsed || "version" in parsed) {
		throw new Error("Invalid MCP capture configuration");
	}
	return {
		...parsed,
		clean: parsed.clean,
		dryRun: false,
		agentFiles: false,
		ignoreRobots: false,
		failOnLowQuality: false,
		failOnInjectionSignal: false,
		json: false,
		quiet: true,
	};
}

function captureInput(value: unknown) {
	const input = objectInput(value, [
		"url",
		"output_dir",
		"max_pages",
		"page_only",
		"clean",
		"concurrency",
		"response_format",
	]);
	return {
		url: stringInput(input, "url"),
		output_dir: optionalOutputDir(input, "output_dir"),
		max_pages: optionalInt(input, "max_pages", 1, 500),
		page_only: optionalBool(input, "page_only", false),
		clean: optionalBool(input, "clean", false),
		concurrency: optionalInt(input, "concurrency", 1, 64),
		response_format: optionalEnum(input, "response_format", [
			"compact",
			"standard",
			"verbose",
		]),
	};
}

function refreshInput(value: unknown) {
	const input = objectInput(value, [
		"output_dir",
		"max_pages",
		"concurrency",
		"response_format",
	]);
	return {
		output_dir: outputDir(input, "output_dir"),
		max_pages: optionalInt(input, "max_pages", 1, 500),
		concurrency: optionalInt(input, "concurrency", 1, 64),
		response_format: optionalEnum(input, "response_format", [
			"compact",
			"standard",
			"verbose",
		]),
	};
}

function corporaInput(value: unknown) {
	const input = objectInput(value, [
		"root_dir",
		"page_size",
		"cursor",
		"response_format",
	]);
	const rootDir = optionalString(input, "root_dir") ?? "docsnap";
	assertSafeProjectRoot(rootDir);
	return {
		root_dir: rootDir,
		page_size: optionalInt(input, "page_size", 1, 100) ?? 25,
		cursor: optionalCursor(input),
		response_format: optionalEnum(input, "response_format", [
			"compact",
			"standard",
		]),
	};
}

function summaryInput(value: unknown) {
	const input = objectInput(value, [
		"output_dir",
		"include_errors",
		"include_refresh_changes",
		"error_limit",
		"response_format",
	]);
	return {
		output_dir: outputDir(input, "output_dir"),
		include_errors: optionalBool(input, "include_errors", true),
		include_refresh_changes: optionalBool(
			input,
			"include_refresh_changes",
			true,
		),
		error_limit: optionalInt(input, "error_limit", 0, 100) ?? 10,
		response_format: optionalEnum(input, "response_format", [
			"compact",
			"standard",
			"verbose",
		]),
	};
}

function pagesInput(value: unknown) {
	const input = objectInput(value, [
		"output_dir",
		"page_size",
		"cursor",
		"include_failures",
		"response_format",
	]);
	return {
		output_dir: outputDir(input, "output_dir"),
		page_size: optionalInt(input, "page_size", 1, 200) ?? 50,
		cursor: optionalCursor(input),
		include_failures: optionalBool(input, "include_failures", false),
		response_format: optionalEnum(input, "response_format", [
			"compact",
			"standard",
		]),
	};
}

function searchInput(value: unknown) {
	const input = objectInput(value, [
		"output_dir",
		"query",
		"path_glob",
		"max_results",
		"snippet_chars",
		"response_format",
	]);
	const output = outputDir(input, "output_dir");
	return {
		output_dir: output,
		query: stringInput(input, "query"),
		path_glob: optionalPathGlob(input),
		max_results: optionalInt(input, "max_results", 1, 50) ?? 10,
		snippet_chars: optionalInt(input, "snippet_chars", 120, 1200) ?? 350,
		response_format: optionalEnum(input, "response_format", [
			"compact",
			"standard",
		]),
	};
}

function readPageInput(value: unknown) {
	const input = objectInput(value, [
		"output_dir",
		"output_path",
		"start_line",
		"max_chars",
		"include_frontmatter",
		"response_format",
	]);
	const output = outputDir(input, "output_dir");
	const path = stringInput(input, "output_path");
	if (!resolvePriorOutputPath({ outDir: output } as Config, path)) {
		throw new Error("output_path must be a safe relative manifest path");
	}
	return {
		output_dir: output,
		output_path: path,
		start_line: optionalInt(input, "start_line", 1, 1_000_000) ?? 1,
		max_chars: optionalInt(input, "max_chars", 500, 25_000) ?? 12_000,
		include_frontmatter: optionalBool(input, "include_frontmatter", true),
		response_format: optionalEnum(input, "response_format", [
			"standard",
			"verbose",
		]),
	};
}

function objectInput(value: unknown, allowed: string[]): ObjectInput {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return {};
	}
	const input = value as ObjectInput;
	for (const key of Object.keys(input)) {
		if (!allowed.includes(key))
			throw new Error(`Unexpected input field: ${key}`);
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

function outputDir(input: ObjectInput, key: string): string {
	return stringInput(input, key);
}

function optionalOutputDir(
	input: ObjectInput,
	key: string,
): string | undefined {
	return optionalString(input, key);
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
	if (typeof input[key] !== "boolean")
		throw new Error(`${key} must be boolean`);
	return input[key];
}

function optionalEnum<T extends string>(
	input: ObjectInput,
	key: string,
	allowed: readonly T[],
): T | undefined {
	if (!(key in input)) return undefined;
	const value = input[key];
	if (typeof value !== "string" || !allowed.includes(value as T)) {
		throw new Error(`${key} must be one of ${allowed.join(", ")}`);
	}
	return value as T;
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

function stderrProgress(message: string): void {
	process.stderr.write(`${message}\n`);
}
