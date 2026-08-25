import { join } from "node:path";
import {
	buildPipelineConfig,
	buildRefreshConfig,
	type ConfigInput,
} from "../core/config.ts";
import { identityKeys } from "../core/identity.ts";
import { citationId } from "../core/text.ts";
import type { FailureKind, PipelineConfig, RunSummary } from "../core/types.ts";
import { runSucceeded } from "../core/types.ts";
import {
	classifyDiscoveryResource,
	looksLikeSpecificContentUrl,
} from "../core/url.ts";
import {
	type Corpus,
	type CorpusPage,
	listAllCorpora,
	manifestMatchesSummary,
	readCorpus,
	readSummary,
	searchCorpus,
} from "../corpus/index.ts";
import { runFiles } from "../output/files.ts";
import { summaryWarnings } from "../report/summary.ts";
import { hasConcealedInjection } from "../security/injection.ts";
import type { FetchInput } from "./args.ts";
import { logLine } from "./progress.ts";
import { failureResult, successResult, writeResult } from "./result.ts";

type FetchScope = "page" | "site";
type FreshnessDecision = "captured" | "refreshed" | "reused";
type FetchCounts = {
	written: number;
	failed: number;
	lowQuality: number;
	qualityWarnings: number;
	injectionSignalPages: number;
};

type FetchBaseResult = {
	ok: boolean;
	message: string;
	next: string;
	warnings: string[];
	action: FreshnessDecision;
	outputDir: string;
	seedUrl: string;
	scope: FetchScope;
	counts: FetchCounts;
	maxPages: number;
	maxReached: boolean;
	stopReason?: RunSummary["stopReason"];
	paths: { summary: string; manifest: string };
	failureKind?: FailureKind;
	error?: string;
};

type FetchCitation = {
	citationId: string;
	path: string;
	lineStart: number;
	lineEnd: number;
	url: string;
	snippet: string;
	kind?: CorpusPage["kind"];
	qualityReasons?: string[];
	injectionSignals?: CorpusPage["injectionSignals"];
};

type FetchQuestionResult = FetchBaseResult & {
	question: string;
	citations: FetchCitation[];
	moreMatches: boolean;
	searchTruncated: boolean;
	injectionFiltered: number;
};

type FetchPage = {
	path: string;
	url: string;
	title?: string;
	kind?: CorpusPage["kind"];
	injectionSignals?: CorpusPage["injectionSignals"];
};

type FetchPagesResult = FetchBaseResult & { pages: FetchPage[] };
type FetchResult = FetchQuestionResult | FetchPagesResult;
type LocatedCorpus = Corpus & { outputDir: string };

const topPagesLimit = 10;
const autoSiteCap = 25;
const defaultSnippets = 5;

export class CorpusMismatchError extends Error {
	readonly failureKind = "corpus_mismatch";

	constructor(
		readonly outputDir: string,
		readonly existingSeedUrl: string,
		readonly requestedSeedUrl: string,
		readonly counts: FetchCounts,
	) {
		super(
			`Existing corpus at ${outputDir} was captured from ${existingSeedUrl} and does not contain ${requestedSeedUrl}.`,
		);
		this.name = "CorpusMismatchError";
	}
}

export async function runFetch(input: FetchInput): Promise<void> {
	let result: FetchResult;
	try {
		result = await fetchResult(input);
	} catch (error) {
		if (error instanceof CorpusMismatchError) {
			writeMismatch(error);
			return;
		}
		throw error;
	}
	writeResult(
		result.ok
			? successResult(
					fetchData(result),
					result.message,
					result.next,
					result.warnings,
				)
			: failureResult(fetchError(result), result.next, result.warnings),
	);
	if (!result.ok) process.exitCode = 1;
}

async function fetchResult(input: FetchInput): Promise<FetchResult> {
	const scope = resolveScope(input);
	const base = buildBaseConfig(input, scope);
	const requested =
		input.freshness === "reuse" ? { ...base, maxExplicit: false } : base;
	const requestedOutputDir = input.outputDir ?? base.outDir;
	const existing = await loadReusableCorpus(
		requested,
		requestedOutputDir,
		input,
	);
	const outputDir = existing?.outputDir ?? requestedOutputDir;
	const prior = existing?.summary ?? null;
	const action: FreshnessDecision = !prior
		? "captured"
		: input.freshness === "reuse"
			? "reused"
			: input.freshness === "refresh"
				? "refreshed"
				: "captured";
	const progress = input.quiet ? undefined : logLine;
	let corpus: Corpus | null = existing;
	if (action !== "reused" || !corpus) {
		const config =
			action === "refreshed" && prior
				? buildRefreshConfig(prior, {
						outDir: outputDir,
						max: input.maxPages,
						cache: input.cache,
					})
				: { ...base, outDir: outputDir };
		if (action === "captured" && input.freshness === "force") {
			config.clean = true;
		}
		const { runPipeline } = await import("../core/pipeline.ts");
		const captured = await runPipeline(config, progress);
		corpus = {
			summary: captured.summary,
			records: captured.records.filter((record) => record.ok),
		};
	}
	const { summary, records } = corpus;
	const baseResult: FetchBaseResult = {
		ok: runSucceeded(summary),
		message: summary.message,
		next: summary.next,
		warnings: summaryWarnings(summary),
		action,
		outputDir,
		seedUrl: summary.seedUrl,
		scope: summary.captureMode,
		counts: summaryCounts(summary),
		maxPages: summary.max,
		maxReached: summary.maxReached,
		paths: {
			summary: join(outputDir, runFiles.summary),
			manifest: join(outputDir, runFiles.manifest),
		},
	};
	if (summary.stopReason) baseResult.stopReason = summary.stopReason;
	if (summary.seed.failureKind)
		baseResult.failureKind = summary.seed.failureKind;
	if (summary.seed.error) baseResult.error = summary.seed.error;
	if (!input.question) {
		return { ...baseResult, pages: topPages(records, input.url) };
	}
	const ranked = await searchCorpus(outputDir, {
		query: input.question,
		maxResults: defaultSnippets,
		snippetChars: input.contextChars,
		excludeInjection: !input.includeInjection,
		preferredOutputPaths: matchingOutputPaths(records, input.url),
		records,
	});
	const injectionFiltered = input.includeInjection
		? 0
		: records.filter(
				(record) =>
					record.ok &&
					Boolean(record.outputPath) &&
					hasConcealedInjection(record.injectionSignals),
			).length;
	const citations = ranked.matches.map((match) => {
		const citation: FetchCitation = {
			citationId: citationId(
				match.record.outputPath,
				match.lineStart,
				match.lineEnd,
				match.contentHash,
			),
			path: match.record.outputPath,
			lineStart: match.lineStart,
			lineEnd: match.lineEnd,
			url: match.record.url,
			snippet: match.text,
		};
		if (match.record.kind) citation.kind = match.record.kind;
		if (match.record.qualityReasons?.length) {
			citation.qualityReasons = match.record.qualityReasons;
		}
		if (match.record.injectionSignals.length) {
			citation.injectionSignals = match.record.injectionSignals;
		}
		return citation;
	});
	return {
		...baseResult,
		message: citations.length
			? `Found ${citations.length} matching passage${citations.length === 1 ? "" : "s"} in a ${summary.written}-page corpus.`
			: `Captured ${summary.written} pages, but found no matching passages.`,
		next: citations.length
			? "Use the cited passages. Search the corpus again only if they do not answer the question."
			: "Search the corpus with different terms; the capture succeeded but this query found no relevant passage.",
		warnings: [
			...baseResult.warnings,
			...(ranked.truncated
				? [
						"Search reached its read limit; the returned passages are usable but may not cover the whole corpus.",
					]
				: []),
			...(injectionFiltered
				? [
						`Excluded ${injectionFiltered} page${injectionFiltered === 1 ? "" : "s"} containing concealed prompt-like text.`,
					]
				: []),
		],
		question: input.question,
		citations,
		moreMatches: ranked.limited,
		searchTruncated: ranked.truncated,
		injectionFiltered,
	};
}

function summaryCounts(summary: RunSummary): FetchCounts {
	return {
		written: summary.written,
		failed: summary.failed,
		lowQuality: summary.lowQuality,
		qualityWarnings: summary.qualityWarnings,
		injectionSignalPages: summary.injectionSignalPages,
	};
}

function writeMismatch(error: CorpusMismatchError): void {
	writeResult(
		failureResult({
			code: "CORPUS_MISMATCH",
			message: error.message,
			retryable: false,
			suggestion:
				"Choose a different output directory or use --freshness force to replace this corpus.",
			details: {
				counts: error.counts,
				outputDir: error.outputDir,
				existingSeedUrl: error.existingSeedUrl,
				requestedUrl: error.requestedSeedUrl,
			},
		}),
	);
	process.exitCode = 1;
}

async function loadReusableCorpus(
	requested: PipelineConfig,
	requestedOutputDir: string,
	input: FetchInput,
): Promise<LocatedCorpus | null> {
	if (!input.outputDir && input.freshness !== "force") {
		const library = await reusableLibraryCorpus(requested);
		if (library) return library;
	}
	const existing = await existingCorpus(
		requestedOutputDir,
		requested,
		input.freshness === "force",
	);
	return existing ? { outputDir: requestedOutputDir, ...existing } : null;
}

async function reusableLibraryCorpus(
	requested: PipelineConfig,
): Promise<LocatedCorpus | null> {
	let latest: LocatedCorpus | null = null;
	let listed: Awaited<ReturnType<typeof listAllCorpora>>;
	try {
		listed = await listAllCorpora("docsnap");
	} catch {
		return null;
	}
	for (const { output_dir } of listed.corpora) {
		try {
			const verified = await readCorpus(output_dir);
			const { summary } = verified;
			if (canReuseCorpus(summary, requested, verified.records)) {
				const candidate = { outputDir: output_dir, ...verified };
				if (
					!latest ||
					summary.generatedAt > latest.summary.generatedAt ||
					(summary.generatedAt === latest.summary.generatedAt &&
						output_dir < latest.outputDir)
				) {
					latest = candidate;
				}
			}
		} catch {}
	}
	return latest;
}

async function existingCorpus(
	outputDir: string,
	requested: PipelineConfig,
	allowReplace: boolean,
): Promise<Corpus | null> {
	let summary: RunSummary;
	try {
		summary = await readSummary(outputDir);
	} catch {
		return null;
	}
	const replaceable =
		allowReplace ||
		!summaryCanBeReused(summary) ||
		(summary.seedUrl === requested.seedUrl &&
			summary.captureMode === (requested.pageOnly ? "page" : "site"));
	let verified: Corpus;
	try {
		verified = await readCorpus(outputDir, summary);
	} catch {
		if (replaceable) return null;
		throw new Error(`Invalid manifest in existing corpus: ${outputDir}`);
	}
	if (canReuseCorpus(summary, requested, verified.records)) return verified;
	if (replaceable) return null;
	throw new CorpusMismatchError(
		outputDir,
		summary.seedUrl,
		requested.seedUrl,
		summaryCounts(summary),
	);
}

function canReuseCorpus(
	summary: RunSummary,
	requested: PipelineConfig,
	records: CorpusPage[],
): boolean {
	const enoughPages =
		!summary.maxReached ||
		!requested.maxExplicit ||
		requested.max <= summary.max;
	if (!summaryCanBeReused(summary) || !enoughPages) return false;
	if (!manifestMatchesSummary(summary, records)) return false;
	const resource = classifyDiscoveryResource(requested.seedUrl);
	if (
		resource &&
		summary.seed.kind === "discovery_resource" &&
		summary.seed.source === resource.source
	) {
		return records.some(
			(record) =>
				record.ok &&
				Boolean(record.outputPath) &&
				record.source === resource.source,
		);
	}
	if (
		!requested.pageOnly &&
		summary.captureMode === "site" &&
		matchesIdentity(
			{ url: summary.seedUrl },
			new Set(identityKeys({ url: requested.seedUrl })),
		)
	) {
		return true;
	}
	return matchingOutputPaths(records, requested.seedUrl).length > 0;
}

function summaryCanBeReused(summary: RunSummary) {
	return (
		summary.ok &&
		summary.seed.included &&
		summary.lowQuality === 0 &&
		!summary.stopReason &&
		(!summary.discoveryTruncated || summary.maxReached) &&
		!summary.render?.truncated
	);
}

function fetchData(result: FetchResult) {
	const {
		ok: _ok,
		message: _message,
		next: _next,
		warnings: _warnings,
		...data
	} = result;
	return data;
}

function fetchError(result: FetchResult) {
	return {
		code: result.failureKind?.toUpperCase() ?? "FETCH_FAILED",
		message: result.message,
		retryable:
			result.failureKind === "timeout" || result.stopReason === "rate_limited",
		suggestion: result.next,
		details: fetchData(result),
	};
}

function buildBaseConfig(input: FetchInput, scope: FetchScope): PipelineConfig {
	const max =
		scope === "page"
			? 1
			: (input.maxPages ?? (input.scope === "auto" ? autoSiteCap : undefined));
	const configInput: ConfigInput = {
		seedUrl: input.url,
		pageOnly: scope === "page",
		site: scope === "site",
		maxExplicit: max !== undefined,
		cache: input.cache,
	};
	if (max !== undefined) configInput.max = max;
	return buildPipelineConfig(configInput);
}

function resolveScope(input: FetchInput): FetchScope {
	if (input.scope === "page") return "page";
	if (input.scope === "site") return "site";
	if (classifyDiscoveryResource(input.url)?.source === "llms") return "site";
	return looksLikeSpecificContentUrl(input.url) ? "page" : "site";
}

function matchingOutputPaths(
	records: CorpusPage[],
	requestedUrl: string,
): string[] {
	const candidates = new Set(identityKeys({ url: requestedUrl }));
	return records.flatMap((record) =>
		record.ok && record.outputPath && matchesIdentity(record, candidates)
			? [record.outputPath]
			: [],
	);
}

function topPages(records: CorpusPage[], requestedUrl: string): FetchPage[] {
	const pages = records.filter(
		(record): record is CorpusPage & { outputPath: string } =>
			record.ok && Boolean(record.outputPath),
	);
	const candidates = new Set(identityKeys({ url: requestedUrl }));
	const requested = pages.find((record) => matchesIdentity(record, candidates));
	return [
		...(requested ? [requested] : []),
		...pages.filter((record) => record !== requested),
	]
		.slice(0, topPagesLimit)
		.map((page) => {
			const result: FetchPage = {
				path: page.outputPath,
				url: page.url,
			};
			if (page.title) result.title = page.title;
			if (page.kind) result.kind = page.kind;
			if (page.injectionSignals.length) {
				result.injectionSignals = page.injectionSignals;
			}
			return result;
		});
}

function matchesIdentity(
	input: Parameters<typeof identityKeys>[0],
	candidates: Set<string>,
) {
	return identityKeys(input).some((key) => candidates.has(key));
}
