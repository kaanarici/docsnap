import { realpath } from "node:fs/promises";
import { nextCaptureMax } from "../core/config.ts";
import { runBounded } from "../core/parallel.ts";
import {
	type RunSummary,
	retryCanHelpFailureKind,
	siteRetryCanHelpFailureKind,
} from "../core/types.ts";
import {
	corpusLimits,
	readOptionalCorpusFileFromRealRoot,
} from "../mcp/access.ts";
import {
	type CorpusPage,
	globMatches,
	listAllCorpora,
	readVerifiedManifest,
	searchCorpus,
} from "../mcp/corpus.ts";
import { buildRankInput, rankPages } from "../mcp/retrieval.ts";
import {
	captureMoreCommand,
	captureSiteCommand,
	inspectSummaryCommand,
	retryCaptureCommand,
} from "../output/commands.ts";
import type { SearchInput } from "./args.ts";
import {
	type CappedCorpus,
	type EmptyCorpus,
	jsonSearchResult,
	type SearchResult,
	textSearchResult,
} from "./search-output.ts";

const snippetChars = 700;
const allSearchConcurrency = 32;

export async function runSearch(input: SearchInput): Promise<void> {
	const result = input.all ? await searchAll(input) : await searchOne(input);
	if (input.json) {
		process.stdout.write(
			`${JSON.stringify(jsonSearchResult(input, result))}\n`,
		);
		return;
	}
	process.stdout.write(textSearchResult(input, result));
}

async function searchOne(input: SearchInput): Promise<SearchResult> {
	const { summary, records } = await readVerifiedManifest(input.outputDir);
	const result = await searchCorpus(input.outputDir, {
		query: input.query,
		...(input.pathGlob ? { pathGlob: input.pathGlob } : {}),
		records,
		maxResults: input.limit,
		snippetChars,
		excludeInjection: input.excludeInjection,
	});
	const hints = corpusHintsForSummaries(
		[{ outputDir: input.outputDir, summary }],
		{ includeEmpty: result.matches.length === 0 },
	);
	return {
		matches: result.matches.map((match) => ({
			corpusDir: input.outputDir,
			match,
		})),
		corporaScanned: 1,
		corporaSearched: hasSearchableRecords(records, input) ? 1 : 0,
		corporaTruncated: false,
		truncated: result.truncated,
		limited: result.limited,
		pagesSkipped: result.skipped,
		injectionFiltered: injectionFiltered(records, input),
		corporaSkipped: 0,
		rawSearchDirs: [input.outputDir],
		cappedCorpora: hints.cappedCorpora,
		emptyCorpora: hints.emptyCorpora,
	};
}

async function searchAll(input: SearchInput): Promise<SearchResult> {
	const listed = await listAllCorpora(input.outputDir);
	const records = await dedupedCorpusRecords(
		listed.corpora.map((corpus) => corpus.output_dir),
		{
			excludeInjection: input.excludeInjection,
			...(input.pathGlob ? { pathGlob: input.pathGlob } : {}),
		},
	);
	const searched = await searchAllRecords(records.corpora, input);
	const hints = corpusHintsForSummaries(records.summaries, {
		includeEmpty: searched.matches.length === 0,
		cappedDirs: new Set(records.corpora.map((corpus) => corpus.corpusDir)),
	});
	return {
		matches: searched.matches,
		corporaScanned: records.scanned,
		corporaSearched: records.corpora.length,
		corporaSkipped: listed.skipped + records.skipped,
		corporaTruncated: listed.truncated,
		truncated: searched.truncated,
		limited: searched.limited,
		pagesSkipped: searched.pagesSkipped,
		injectionFiltered: records.injectionFiltered,
		rawSearchDirs: records.corpora.map((corpus) => corpus.corpusDir),
		cappedCorpora: hints.cappedCorpora,
		emptyCorpora: hints.emptyCorpora,
	};
}

type AllSearchPage = CorpusPage & { corpusDir: string; outputPath: string };

async function searchAllRecords(
	corpora: CorpusRecords[],
	input: SearchInput,
): Promise<
	Pick<SearchResult, "matches" | "truncated" | "limited" | "pagesSkipped">
> {
	const roots = new Map<string, string>();
	for (const corpus of corpora)
		roots.set(corpus.corpusDir, await realpath(corpus.corpusDir));
	const pages = corpora.flatMap((corpus) =>
		(corpus.records ?? []).map(
			(record) => ({ ...record, corpusDir: corpus.corpusDir }) as AllSearchPage,
		),
	);
	const {
		input: rankInput,
		truncated,
		skipped,
	} = await buildRankInput(
		pages,
		(record) => {
			const page = record as AllSearchPage;
			return readOptionalCorpusFileFromRealRoot(
				page.corpusDir,
				roots.get(page.corpusDir)!,
				page.outputPath,
				corpusLimits.pageBytes,
			);
		},
		{ maxPages: corpusLimits.searchPages, maxBytes: corpusLimits.searchBytes },
		{ query: input.query },
	);
	const ranked = rankPages(rankInput, input.query, {
		maxResults: input.limit + 1,
		snippetChars,
		excludeInjection: input.excludeInjection,
	});
	return {
		matches: ranked.slice(0, input.limit).map((match) => ({
			corpusDir: (match.record as AllSearchPage).corpusDir,
			match,
		})),
		truncated,
		limited: ranked.length > input.limit,
		pagesSkipped: skipped,
	};
}

async function dedupedCorpusRecords(
	corpusDirs: string[],
	options: { excludeInjection: boolean; pathGlob?: string },
): Promise<{
	corpora: CorpusRecords[];
	scanned: number;
	injectionFiltered: number;
	skipped: number;
	summaries: CorpusSummary[];
}> {
	const loaded = await runBounded(
		corpusDirs,
		{ concurrency: allSearchConcurrency, perOrigin: 1, key: (dir) => dir },
		readCorpusRecords,
	);
	const byUrl = new Map<string, CorpusRecord>();
	let scanned = 0;
	let injectionFiltered = 0;
	let skipped = 0;
	const summaries: CorpusSummary[] = [];
	for (const item of loaded) {
		if (!item.records || !item.summary) {
			skipped++;
			continue;
		}
		scanned++;
		const { corpusDir, records, summary } = item;
		summaries.push({ outputDir: corpusDir, summary });
		for (const record of records) {
			if (!record.ok || !record.outputPath) continue;
			if (options.pathGlob && !globMatches(options.pathGlob, record.outputPath))
				continue;
			if (options.excludeInjection && record.injectionSignals.length) {
				injectionFiltered++;
				continue;
			}
			const current = byUrl.get(record.finalUrl);
			const next = { corpusDir, record };
			if (!current || preferRecord(next, current))
				byUrl.set(record.finalUrl, next);
		}
	}
	const groups = new Map<string, CorpusPage[]>();
	for (const { corpusDir, record } of byUrl.values()) {
		const records = groups.get(corpusDir) ?? [];
		records.push(record);
		groups.set(corpusDir, records);
	}
	return {
		corpora: [...groups.entries()]
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([corpusDir, records]) => ({ corpusDir, records })),
		scanned,
		injectionFiltered,
		skipped,
		summaries,
	};
}

type CorpusRecords = {
	corpusDir: string;
	summary?: RunSummary;
	records?: CorpusPage[];
};

async function readCorpusRecords(corpusDir: string): Promise<CorpusRecords> {
	try {
		return { corpusDir, ...(await readVerifiedManifest(corpusDir)) };
	} catch {
		return { corpusDir };
	}
}

type CorpusSummary = { outputDir: string; summary: RunSummary };

type CorpusHints = {
	cappedCorpora: CappedCorpus[];
	emptyCorpora: EmptyCorpus[];
};

const maxCappedHints = 3;
const maxEmptyHints = 3;
function corpusHintsForSummaries(
	summaries: CorpusSummary[],
	options: { includeEmpty: boolean; cappedDirs?: Set<string> },
): CorpusHints {
	const hints: CorpusHints = { cappedCorpora: [], emptyCorpora: [] };
	for (const { outputDir, summary } of summaries) {
		const nextMax = summary.maxReached
			? nextCaptureMax(summary.max)
			: undefined;
		if (
			nextMax !== undefined &&
			(options.cappedDirs === undefined || options.cappedDirs.has(outputDir)) &&
			hints.cappedCorpora.length < maxCappedHints
		) {
			hints.cappedCorpora.push({
				outputDir,
				seedUrl: summary.seedUrl,
				command: captureMoreCommand(
					summary.seedUrl,
					outputDir,
					summary.captureMode,
					nextMax,
				),
			});
		}
		if (
			options.includeEmpty &&
			summary.written === 0 &&
			hints.emptyCorpora.length < maxEmptyHints
		) {
			hints.emptyCorpora.push({
				outputDir,
				seedUrl: summary.seedUrl,
				commands: {
					inspect_summary: inspectSummaryCommand(outputDir),
					...(retryCanHelpFailureKind(summary.seed.failureKind)
						? {
								retry_capture: retryCaptureCommand(
									summary.seedUrl,
									outputDir,
									summary.captureMode,
									summary.max,
								),
							}
						: {}),
					...(summary.captureMode === "page" &&
					siteRetryCanHelpFailureKind(summary.seed.failureKind)
						? {
								capture_site: captureSiteCommand(
									summary.seedUrl,
									outputDir,
									summary.max,
								),
							}
						: {}),
				},
			});
		}
		const enoughCapped = hints.cappedCorpora.length >= maxCappedHints;
		const enoughEmpty =
			!options.includeEmpty || hints.emptyCorpora.length >= maxEmptyHints;
		if (enoughCapped && enoughEmpty) break;
	}
	return hints;
}

type CorpusRecord = {
	corpusDir: string;
	record: CorpusPage;
};

function preferRecord(next: CorpusRecord, current: CorpusRecord) {
	const left = next.record.fetchedAt ?? "";
	const right = current.record.fetchedAt ?? "";
	if (left !== right) return left > right;
	return next.corpusDir < current.corpusDir;
}

function injectionFiltered(records: CorpusPage[], input: SearchInput) {
	if (!input.excludeInjection) return 0;
	return records.filter(
		(record) =>
			record.ok &&
			record.outputPath &&
			(!input.pathGlob || globMatches(input.pathGlob, record.outputPath)) &&
			record.injectionSignals.length > 0,
	).length;
}

function hasSearchableRecords(records: CorpusPage[], input: SearchInput) {
	return records.some(
		(record) =>
			record.ok &&
			record.outputPath &&
			(!input.pathGlob || globMatches(input.pathGlob, record.outputPath)) &&
			(!input.excludeInjection || record.injectionSignals.length === 0),
	);
}
