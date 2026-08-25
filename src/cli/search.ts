import { realpath } from "node:fs/promises";
import { runBounded } from "../core/parallel.ts";
import {
	corpusLimits,
	readBoundedCorpusFileFromRealRoot,
} from "../corpus/access.ts";
import {
	type CorpusPage,
	globMatches,
	listAllCorpora,
	readCorpus,
	searchCorpus,
	verifyPageBody,
} from "../corpus/index.ts";
import {
	assertSearchQuery,
	buildRankInput,
	rankPages,
} from "../search/rank.ts";
import { hasConcealedInjection } from "../security/injection.ts";
import type { SearchInput } from "./args.ts";
import { successResult, writeResult } from "./result.ts";
import { jsonSearchResult, type SearchResult } from "./search-output.ts";

const snippetChars = 500;
const allSearchConcurrency = 32;

export async function runSearch(input: SearchInput): Promise<void> {
	assertSearchQuery(input.query);
	const result = input.all ? await searchAll(input) : await searchOne(input);
	const matches = result.matches.length;
	const message = `Found ${matches} matching passage${matches === 1 ? "" : "s"}.`;
	const next = matches
		? "Use the cited passages. Search again only if they do not answer the question."
		: result.injectionFiltered
			? "Use another source, or rerun with --include-injection only if you need to inspect the flagged pages as untrusted source material."
			: "Try different search terms; the corpus was searched successfully.";
	const warnings = [
		...(result.truncated || result.corporaTruncated
			? ["Search stopped at a corpus scan or read limit."]
			: []),
		...(result.limited
			? ["More ranked matches exist beyond the requested limit."]
			: []),
		...(result.injectionFiltered
			? [
					`Excluded ${result.injectionFiltered} page${result.injectionFiltered === 1 ? "" : "s"} containing concealed prompt-like text.`,
				]
			: []),
	];
	writeResult(
		successResult(jsonSearchResult(input, result), message, next, warnings),
	);
}

async function searchOne(input: SearchInput): Promise<SearchResult> {
	const { records } = await readCorpus(input.outputDir);
	const searchOptions = {
		query: input.query,
		records,
		maxResults: input.limit,
		snippetChars,
		excludeInjection: !input.includeInjection,
	};
	const result = await searchCorpus(
		input.outputDir,
		input.pathGlob
			? { ...searchOptions, pathGlob: input.pathGlob }
			: searchOptions,
	);
	return {
		matches: result.matches.map((match) => ({
			corpusDir: input.outputDir,
			match,
		})),
		corporaScanned: 1,
		corporaSearched: records.some(
			(record) =>
				searchableRecord(record, input) &&
				(input.includeInjection ||
					!hasConcealedInjection(record.injectionSignals)),
		)
			? 1
			: 0,
		corporaTruncated: false,
		truncated: result.truncated,
		limited: result.limited,
		injectionFiltered: input.includeInjection
			? 0
			: records.filter(
					(record) =>
						searchableRecord(record, input) &&
						hasConcealedInjection(record.injectionSignals),
				).length,
		corporaSkipped: 0,
	};
}

async function searchAll(input: SearchInput): Promise<SearchResult> {
	const listed = await listAllCorpora(input.outputDir);
	const recordOptions = input.pathGlob
		? {
				excludeInjection: !input.includeInjection,
				pathGlob: input.pathGlob,
			}
		: { excludeInjection: !input.includeInjection };
	const records = await dedupedCorpusRecords(
		listed.corpora.map((corpus) => corpus.output_dir),
		recordOptions,
	);
	const searched = await searchAllRecords(records.corpora, input);
	return {
		matches: searched.matches,
		corporaScanned: records.scanned,
		corporaSearched: records.corpora.length,
		corporaSkipped: listed.skipped + records.skipped,
		corporaTruncated: listed.truncated,
		truncated: searched.truncated,
		limited: searched.limited,
		injectionFiltered: records.injectionFiltered,
	};
}

async function searchAllRecords(
	corpora: CorpusRecords[],
	input: SearchInput,
): Promise<Pick<SearchResult, "matches" | "truncated" | "limited">> {
	const roots = new Map<string, string>();
	for (const corpus of corpora)
		roots.set(corpus.corpusDir, await realpath(corpus.corpusDir));
	const corpusByRecord = new Map<CorpusPage, string>();
	const pages = corpora.flatMap((corpus) => {
		for (const record of corpus.records ?? []) {
			corpusByRecord.set(record, corpus.corpusDir);
		}
		return corpus.records ?? [];
	});
	const { input: rankInput, truncated } = await buildRankInput(
		pages,
		async (record) => {
			const corpusDir = corpusByRecord.get(record);
			if (!corpusDir) throw new Error("Search record lost its corpus owner");
			const realRoot = roots.get(corpusDir);
			if (!realRoot) throw new Error("Search corpus root is unavailable");
			const body = await readBoundedCorpusFileFromRealRoot(
				corpusDir,
				realRoot,
				record.outputPath,
				corpusLimits.pageBytes,
			);
			return verifyPageBody(record, body);
		},
		{ maxPages: corpusLimits.searchPages, maxBytes: corpusLimits.searchBytes },
		{ query: input.query },
	);
	const ranked = rankPages(rankInput, input.query, {
		maxResults: input.limit + 1,
		snippetChars,
	});
	return {
		matches: ranked.slice(0, input.limit).map((match) => ({
			corpusDir: corpusByRecord.get(match.record) ?? "",
			match,
		})),
		truncated,
		limited: ranked.length > input.limit,
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
}> {
	const loaded = await runBounded(
		corpusDirs,
		{ concurrency: allSearchConcurrency, perOrigin: 1, key: (dir) => dir },
		async (corpusDir): Promise<CorpusRecords> => {
			try {
				return {
					corpusDir,
					records: (await readCorpus(corpusDir)).records,
				};
			} catch {
				return { corpusDir };
			}
		},
	);
	const byUrl = new Map<string, CorpusRecord>();
	let scanned = 0;
	let injectionFiltered = 0;
	let skipped = 0;
	for (const item of loaded) {
		if (!item.records) {
			skipped++;
			continue;
		}
		scanned++;
		const { corpusDir, records } = item;
		for (const record of records) {
			if (!record.ok || !record.outputPath) continue;
			if (options.pathGlob && !globMatches(options.pathGlob, record.outputPath))
				continue;
			if (
				options.excludeInjection &&
				hasConcealedInjection(record.injectionSignals)
			) {
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
	};
}

type CorpusRecords = { corpusDir: string; records?: CorpusPage[] };

type CorpusRecord = { corpusDir: string; record: CorpusPage };

function preferRecord(next: CorpusRecord, current: CorpusRecord) {
	const left = next.record.fetchedAt ?? "";
	const right = current.record.fetchedAt ?? "";
	if (left !== right) return left > right;
	return next.corpusDir < current.corpusDir;
}

function searchableRecord(record: CorpusPage, input: SearchInput) {
	return (
		record.ok &&
		record.outputPath &&
		(!input.pathGlob || globMatches(input.pathGlob, record.outputPath))
	);
}
