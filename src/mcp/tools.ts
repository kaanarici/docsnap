import { citationId } from "../core/citation.ts";
import { buildPipelineConfig, nextCaptureMax } from "../core/config.ts";
import { runPipeline } from "../core/pipeline.ts";
import {
	canBroadenAfterFailure,
	canRetryAfterFailure,
	type PipelineConfig,
	type RunSummary,
} from "../core/types.ts";
import { siteDiscoverySeedUrl } from "../core/url.ts";
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
	errorToolResult,
	frameWebContent,
	jsonToolResult,
	mcpCaptureArgs,
	mcpCorpusPagePath,
	mcpSnippetCitation,
	readPageNextAction,
	refreshResult,
	snippetFence,
	snippetFenceNote,
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
		await runFetchTool(input, { progress: stderrProgress }, state),
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
	const config = configForRefresh({ ...input, output_dir: outputDir }, prior);
	const result = await runPipeline(config, stderrProgress);
	rememberCorpus(state, result.summary.outDir);
	return jsonToolResult(refreshResult(result.summary));
}

async function corpora(args: unknown, state: McpState) {
	const input = corporaInput(args);
	const result = await listCorpora(
		input.root_dir,
		input.page_size,
		input.cursor,
		state.corpora,
	);
	return jsonToolResult(
		resultNextActions(result, input.root_dir, input.page_size),
	);
}

type CorporaResult = Awaited<ReturnType<typeof listCorpora>>;

function resultNextActions(
	result: CorporaResult,
	rootDir: string,
	pageSize: number,
) {
	const actions: string[] = [];
	if (result.corpora.length === 0) {
		if (result.corporaSkipped) {
			actions.push(
				"Recapture into a clean corpus directory or remove skipped invalid corpus directories before searching this local library.",
			);
		}
		actions.push(
			`Capture a public docs URL with docsnap_capture ${JSON.stringify({ url: "https://react.dev/reference" })}.`,
			`Or fetch cited context in one step with docsnap_fetch ${JSON.stringify({ url: "https://react.dev/reference/react/useEffect", question: "cleanup function" })}.`,
		);
	} else {
		const firstSearchable = result.corpora.find((corpus) => corpus.written > 0);
		const firstEmpty = result.corpora.find((corpus) => corpus.written === 0);
		const firstCapped = result.corpora.find(
			(corpus) =>
				corpus.max_reached && nextCaptureMax(corpus.max_pages) !== undefined,
		);
		if (firstSearchable) {
			actions.push(
				`Search the newest corpus with docsnap_search_corpus ${JSON.stringify({ output_dir: firstSearchable.output_dir, query: "<term>" })}.`,
				`Inspect corpus health with docsnap_get_corpus_summary ${JSON.stringify({ output_dir: firstSearchable.output_dir })}.`,
			);
		}
		if (firstEmpty) {
			actions.push(
				`Inspect zero-page corpus health with docsnap_get_corpus_summary ${JSON.stringify({ output_dir: firstEmpty.output_dir, include_errors: true })}.`,
			);
		}
		if (firstCapped) {
			const nextMax = nextCaptureMax(firstCapped.max_pages);
			if (nextMax !== undefined) {
				actions.push(
					`Broaden capped corpus coverage with docsnap_capture ${JSON.stringify(mcpCaptureArgs({ seedUrl: firstCapped.seed_url, outputDir: firstCapped.output_dir, captureMode: firstCapped.capture_mode, maxPages: nextMax }))}.`,
				);
			}
		}
	}
	if (result.next_cursor) {
		actions.push(
			`Continue listing with docsnap_list_corpora ${JSON.stringify({ root_dir: rootDir, page_size: pageSize, cursor: result.next_cursor })}.`,
		);
	}
	return actions.length ? { ...result, next_actions: actions } : result;
}

async function corpusSummary(args: unknown, state: McpState) {
	const input = summaryInput(args);
	const outputDir = await readableCorpusDir(input.output_dir, state.corpora);
	const result = await getCorpusSummary(outputDir, {
		includeErrors: input.include_errors,
		includeRefreshChanges: input.include_refresh_changes,
		errorLimit: input.error_limit,
	});
	return jsonToolResult(summaryNextActions(result, outputDir));
}

type SummaryResult = Awaited<ReturnType<typeof getCorpusSummary>>;

function summaryNextActions(result: SummaryResult, outputDir: string) {
	const actions: string[] = [];
	if (result.counts.written > 0) {
		actions.push(
			`Search this corpus with docsnap_search_corpus ${JSON.stringify({ output_dir: outputDir, query: "<term>" })}.`,
			`Browse pages with docsnap_list_pages ${JSON.stringify({ output_dir: outputDir, page_size: 25 })}.`,
			`Refresh this corpus with docsnap_refresh ${JSON.stringify({ output_dir: outputDir })}.`,
		);
	} else {
		const failureKind = result.corpus.seed_status.failure_kind;
		if (canRetryAfterFailure(failureKind)) {
			actions.push(
				`No Markdown pages were captured; retry from the seed with docsnap_capture ${JSON.stringify(mcpCaptureArgs({ seedUrl: result.corpus.seed_url, outputDir, captureMode: result.corpus.capture_mode, maxPages: result.limits.max_pages }))}.`,
			);
		}
		if (
			result.corpus.capture_mode === "page" &&
			canBroadenAfterFailure(failureKind)
		) {
			actions.push(
				`If the exact page URL is too narrow, try site discovery with docsnap_capture ${JSON.stringify(mcpCaptureArgs({ seedUrl: siteDiscoverySeedUrl(result.corpus.seed_url), outputDir, captureMode: "site", maxPages: result.limits.max_pages }))}.`,
			);
		}
		if (
			!canRetryAfterFailure(failureKind) &&
			!(
				result.corpus.capture_mode === "page" &&
				canBroadenAfterFailure(failureKind)
			)
		) {
			actions.push(
				"No Markdown pages were captured; choose another reachable public docs URL after inspecting the failure kind.",
			);
		}
	}
	if (result.counts.failed > 0) {
		actions.push(
			`Inspect failed pages with docsnap_get_corpus_summary ${JSON.stringify({ output_dir: outputDir, include_errors: true })}.`,
		);
	}
	if (result.counts.max_reached) {
		const nextMax = nextCaptureMax(result.limits.max_pages);
		if (nextMax !== undefined) {
			actions.push(
				`If coverage is too small, recapture with docsnap_capture ${JSON.stringify(mcpCaptureArgs({ seedUrl: result.corpus.seed_url, outputDir, captureMode: result.corpus.capture_mode, maxPages: nextMax }))}.`,
			);
		}
	}
	return actions.length ? { ...result, next_actions: actions } : result;
}

async function pages(args: unknown, state: McpState) {
	const input = pagesInput(args);
	const outputDir = await readableCorpusDir(input.output_dir, state.corpora);
	const result = await listPages(
		outputDir,
		input.page_size,
		input.cursor,
		input.include_failures,
	);
	return jsonToolResult(
		pageListNextActions(
			result,
			outputDir,
			input.page_size,
			input.include_failures,
		),
	);
}

type PagesResult = Awaited<ReturnType<typeof listPages>>;

function pageListNextActions(
	result: PagesResult,
	outputDir: string,
	pageSize: number,
	includeFailures: boolean,
) {
	const actions: string[] = [];
	const first = result.pages.find((page) => page.output_path);
	if (first?.output_path) {
		actions.push(
			`Read the first page with docsnap_read_page ${JSON.stringify({ output_dir: outputDir, output_path: first.output_path, max_chars: 4000 })}.`,
			`Search this corpus with docsnap_search_corpus ${JSON.stringify({ output_dir: outputDir, query: "<term>" })}.`,
		);
	} else {
		actions.push(
			`No readable page paths returned; inspect corpus health with docsnap_get_corpus_summary ${JSON.stringify({ output_dir: outputDir })}.`,
		);
	}
	if (result.next_cursor) {
		actions.push(
			`Continue listing pages with docsnap_list_pages ${JSON.stringify({ output_dir: outputDir, page_size: pageSize, cursor: result.next_cursor, include_failures: includeFailures })}.`,
		);
	}
	return actions.length ? { ...result, next_actions: actions } : result;
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
	const fence = snippetFence();
	return jsonToolResult({
		query: input.query,
		match_count: result.matches.length,
		web_snippet_fence: fence,
		matches: result.matches.map((match) => mcpSnippetCitation(match, fence)),
		truncated: result.truncated,
		limited: result.limited,
		pages_skipped: result.skipped,
		next_actions: searchNextActions(outputDir, fence, result.matches[0]),
	});
}

function searchNextActions(
	outputDir: string,
	fence: string,
	firstMatch?: Awaited<ReturnType<typeof searchCorpus>>["matches"][number],
): string[] {
	if (!firstMatch) {
		return [
			"No matches found; try broader terms, list pages, or inspect the corpus summary before answering.",
		];
	}
	return [
		readPageNextAction(
			outputDir,
			firstMatch.record.outputPath,
			firstMatch.lineStart,
			firstMatch.lineEnd,
		),
		snippetFenceNote(fence),
	];
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
			finalUrl: page.record.finalUrl,
			corpusPath: mcpCorpusPagePath(outputDir, input.output_path),
			injectionSignals: page.record.injectionSignals,
			body: page.text,
			truncated: page.truncated,
		}),
	});
}

async function contextPack(args: unknown, state: McpState) {
	const input = contextPackInput(args);
	const outputDir = await readableCorpusDir(input.output_dir, state.corpora);
	const summary = await readSummary(outputDir);
	const coverageAction = contextCoverageAction(summary, outputDir);
	return jsonToolResult(
		await buildContextPack(outputDir, {
			query: input.query,
			maxSnippets: input.max_snippets,
			contextChars: input.context_chars,
			...(input.path_glob ? { pathGlob: input.path_glob } : {}),
			excludeInjection: input.safety === "exclude_injection",
			...(coverageAction ? { coverageAction } : {}),
		}),
	);
}

function contextCoverageAction(summary: RunSummary, outputDir: string) {
	if (summary.written === 0) {
		return `No Markdown pages are available; inspect corpus health with docsnap_get_corpus_summary ${JSON.stringify({ output_dir: outputDir, include_errors: true })}.`;
	}
	if (!summary.maxReached) return undefined;
	const nextMax = nextCaptureMax(summary.max);
	if (nextMax === undefined) return undefined;
	return `If the corpus is too small, recapture with docsnap_capture ${JSON.stringify(mcpCaptureArgs({ seedUrl: summary.seedUrl, outputDir, captureMode: summary.captureMode, maxPages: nextMax }))}.`;
}

function configForCapture(
	input: ReturnType<typeof captureInput>,
): PipelineConfig {
	return buildPipelineConfig({
		seedUrl: input.url,
		...(input.output_dir ? { outDir: input.output_dir } : {}),
		...(input.max_pages !== undefined ? { max: input.max_pages } : {}),
		...(input.page_only !== undefined ? { pageOnly: input.page_only } : {}),
		clean: input.clean,
		...(input.concurrency !== undefined
			? { concurrency: input.concurrency }
			: {}),
	});
}

function configForRefresh(
	input: ReturnType<typeof refreshInput>,
	prior: RunSummary,
): PipelineConfig {
	return buildPipelineConfig({
		seedUrl: prior.seedUrl,
		outDir: input.output_dir,
		max: input.max_pages ?? prior.max,
		maxExplicit:
			input.max_pages !== undefined ? true : prior.maxAppliesTo === "all",
		...(input.concurrency !== undefined
			? { concurrency: input.concurrency }
			: {}),
		pageOnly: prior.captureMode === "page",
		userAgent: prior.userAgent,
	});
}

function stderrProgress(message: string): void {
	process.stderr.write(`${message}\n`);
}
