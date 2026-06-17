import { parseArgs } from "../cli/args.ts";
import { runPipeline } from "../core/pipeline.ts";
import type { Config } from "../core/types.ts";
import {
	type McpState,
	readableCorpusDir,
	rememberCorpus,
	writableCorpusDir,
} from "./access.ts";
import { buildContextPack } from "./context-pack.ts";
import {
	getCorpusSummary,
	listCorpora,
	listPages,
	readPageSlice,
	readSummary,
	searchCorpus,
} from "./corpus.ts";
import { exampleFor, toolDefinitions } from "./definitions.ts";
import { runFetchTool } from "./fetch.ts";
import {
	captureInput,
	contextPackInput,
	corporaInput,
	fetchInput,
	pagesInput,
	readPageInput,
	refreshInput,
	searchInput,
	summaryInput,
} from "./inputs.ts";
import {
	captureResult,
	citationId,
	errorToolResult,
	frameWebContent,
	jsonToolResult,
	refreshResult,
	type ToolResult,
} from "./results.ts";

export function listTools() {
	return { tools: toolDefinitions };
}

export async function callTool(
	name: string,
	args: unknown,
	state: McpState,
): Promise<ToolResult> {
	try {
		if (name === "docsnap_fetch") return await fetch(args, state);
		if (name === "docsnap_capture") return await capture(args, state);
		if (name === "docsnap_refresh") return await refresh(args, state);
		if (name === "docsnap_list_corpora") return await corpora(args, state);
		if (name === "docsnap_get_corpus_summary")
			return await corpusSummary(args, state);
		if (name === "docsnap_list_pages") return await pages(args, state);
		if (name === "docsnap_search_corpus") return await search(args, state);
		if (name === "docsnap_read_page") return await readPage(args, state);
		if (name === "docsnap_context_pack") return await contextPack(args, state);
		throw new Error(`Unknown tool: ${name}`);
	} catch (error) {
		return errorToolResult(name, error, exampleFor(name));
	}
}

async function fetch(args: unknown, state: McpState) {
	const input = fetchInput(args);
	return jsonToolResult(
		await runFetchTool(
			input,
			{ buildConfig: controlledConfig, progress: stderrProgress },
			state,
		),
	);
}

async function capture(args: unknown, state: McpState) {
	const input = captureInput(args);
	const output_dir = input.output_dir
		? await writableCorpusDir(input.output_dir)
		: input.output_dir;
	const result = await runPipeline(
		configForCapture({ ...input, output_dir }),
		stderrProgress,
	);
	rememberCorpus(state, result.summary.outDir);
	return jsonToolResult(captureResult(result.summary));
}

async function refresh(args: unknown, state: McpState) {
	const input = refreshInput(args);
	const outputDir = await readableCorpusDir(input.output_dir, state.corpora);
	const prior = await readSummary(outputDir);
	const config = configForRefresh(
		{ ...input, output_dir: outputDir },
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
		excludeInjection: input.safety === "exclude_injection",
	});
	return jsonToolResult({
		query: input.query,
		matches: result.matches.map((match) => ({
			citation_id: citationId(
				match.record.outputPath,
				match.lineStart,
				match.lineEnd,
				match.contentHash,
			),
			output_path: match.record.outputPath,
			url: match.record.url,
			...(match.record.title
				? { untrusted_web_title: match.record.title }
				: {}),
			line_start: match.lineStart,
			line_end: match.lineEnd,
			score: Math.round(match.score * 1000) / 1000,
			confidence: match.confidence,
			extractor: match.extractor,
			content_hash: match.contentHash,
			...(match.record.injectionSignals.length
				? { injection_signals: match.record.injectionSignals }
				: {}),
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
	const page = await readPageSlice(outputDir, input.output_path, {
		startLine: input.start_line,
		...(input.end_line !== undefined ? { endLine: input.end_line } : {}),
		maxChars: input.max_chars,
		includeFrontmatter: input.include_frontmatter,
	});
	const contentHash = page.record.contentHash ?? "";
	return jsonToolResult({
		page: {
			citation_id: citationId(
				input.output_path,
				page.startLine,
				page.endLine,
				contentHash,
			),
			output_path: input.output_path,
			url: page.record.url,
			final_url: page.record.finalUrl,
			...(page.record.title ? { untrusted_web_title: page.record.title } : {}),
			start_line: page.startLine,
			end_line: page.endLine,
			content_hash: contentHash,
			...(page.record.extractor ? { extractor: page.record.extractor } : {}),
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

async function contextPack(args: unknown, state: McpState) {
	const input = contextPackInput(args);
	const outputDir = await readableCorpusDir(input.output_dir, state.corpora);
	return jsonToolResult(
		await buildContextPack(outputDir, {
			query: input.query,
			maxSnippets: input.max_snippets,
			contextChars: input.context_chars,
			...(input.path_glob ? { pathGlob: input.path_glob } : {}),
			excludeInjection: input.safety === "exclude_injection",
		}),
	);
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
		dryRun: false,
		agentFiles: false,
		ignoreRobots: false,
		failOnLowQuality: false,
		failOnInjectionSignal: false,
		json: false,
		quiet: true,
	};
}

function stderrProgress(message: string): void {
	process.stderr.write(`${message}\n`);
}
