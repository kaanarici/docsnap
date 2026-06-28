import type { PipelineConfig, RunSummary } from "../core/types.ts";
import type { McpState } from "../mcp/access.ts";
import {
	type CorpusPage,
	listAllCorpora,
	readSummary,
	readVerifiedManifest,
} from "../mcp/corpus.ts";
import {
	CorpusMismatchError,
	canReplaceCorpus,
	canReuseCorpus,
	runFetchTool,
	throwCorpusMismatch,
} from "../mcp/fetch.ts";
import type { FetchToolInput } from "../mcp/inputs.ts";
import type { FetchInput } from "./args.ts";
import {
	jsonFetchResult,
	textFetchResult,
	writeCorpusMismatchError,
} from "./fetch-output.ts";
import { logLine } from "./progress.ts";

export async function runFetch(input: FetchInput): Promise<void> {
	const progress = input.quiet || input.json ? silentProgress : logLine;
	const state: McpState = { corpora: new Set(), resourceCorpora: new Map() };
	let result: Awaited<ReturnType<typeof runFetchTool>>;
	try {
		result = await runFetchTool(
			toFetchToolInput(input),
			{
				progress,
				resolveOutputDir: (outputDir, requested) =>
					cliOutputDir(input, outputDir, requested),
				readExistingSummary: readExistingCliSummary,
			},
			state,
		);
	} catch (error) {
		if (error instanceof CorpusMismatchError) {
			writeCorpusMismatchError(error, input);
			return;
		}
		throw error;
	}
	if (input.json) {
		process.stdout.write(`${JSON.stringify(jsonFetchResult(result, input))}\n`);
		if (!result.ok) process.exitCode = 1;
		return;
	}
	process.stdout.write(textFetchResult(result, input));
	if (!result.ok) process.exitCode = 1;
}

function toFetchToolInput(input: FetchInput): FetchToolInput {
	return {
		url: input.url,
		...(input.question ? { question: input.question } : {}),
		scope: input.scope,
		...(input.outputDir ? { output_dir: input.outputDir } : {}),
		...(input.maxPages !== undefined ? { max_pages: input.maxPages } : {}),
		freshness: input.freshness,
		context_chars: input.contextChars,
		safety: input.excludeInjection ? "exclude_injection" : "flag_all",
		cache: input.cache,
	};
}

function silentProgress(_message: string): void {}

async function cliOutputDir(
	input: FetchInput,
	outputDir: string,
	requested: PipelineConfig,
) {
	if (input.outputDir || input.freshness === "force") return outputDir;
	return (await reusableLibraryCorpus(requested)) ?? outputDir;
}

async function reusableLibraryCorpus(
	requested: PipelineConfig,
): Promise<string | null> {
	let latest: { outputDir: string; generatedAt: string } | null = null;
	let listed: Awaited<ReturnType<typeof listAllCorpora>>;
	try {
		listed = await listAllCorpora("docsnap");
	} catch {
		return null;
	}
	for (const { output_dir } of listed.corpora) {
		try {
			const summary = await readSummary(output_dir);
			const records = (await readVerifiedManifest(output_dir, summary)).records;
			if (canReuseCorpus(summary, requested, records)) {
				latest = newerCorpus(latest, output_dir, summary.generatedAt);
			}
		} catch {}
	}
	return latest?.outputDir ?? null;
}

function newerCorpus(
	current: { outputDir: string; generatedAt: string } | null,
	outputDir: string,
	generatedAt: string,
) {
	if (
		!current ||
		generatedAt > current.generatedAt ||
		(generatedAt === current.generatedAt && outputDir < current.outputDir)
	) {
		return { outputDir, generatedAt };
	}
	return current;
}

async function readExistingCliSummary(
	outputDir: string,
	_state: McpState,
	requested: PipelineConfig,
	allowReplace: boolean,
) {
	let summary: RunSummary;
	try {
		summary = await readSummary(outputDir);
	} catch {
		return null;
	}
	let records: CorpusPage[];
	try {
		records = (await readVerifiedManifest(outputDir, summary)).records;
	} catch {
		if (canReplaceCorpus(summary, requested, allowReplace)) return null;
		throw new Error(`Invalid manifest in existing corpus: ${outputDir}`);
	}
	if (canReuseCorpus(summary, requested, records)) return summary;
	return canReplaceCorpus(summary, requested, allowReplace)
		? null
		: throwCorpusMismatch(outputDir, summary, requested);
}
