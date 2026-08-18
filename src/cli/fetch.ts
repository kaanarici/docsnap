import { join } from "node:path";
import {
	buildPipelineConfig,
	buildRefreshConfig,
	type ConfigInput,
} from "../core/config.ts";
import {
	corpusFreshness,
	corpusIsStale,
	type FreshnessDecision,
} from "../core/freshness.ts";
import { identityKeys } from "../core/identity.ts";
import { citationId, terminalText } from "../core/text.ts";
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
import type { FetchInput } from "./args.ts";
import { logLine } from "./progress.ts";

type FetchScope = "page" | "site";
type FetchCounts = {
	written: number;
	failed: number;
	lowQuality: number;
	qualityWarnings: number;
	injectionSignalPages: number;
};

type FetchBaseResult = {
	ok: boolean;
	action: FreshnessDecision;
	status: RunSummary["status"];
	outputDir: string;
	seedUrl: string;
	scope: FetchScope;
	counts: FetchCounts;
	memory: ReturnType<typeof corpusFreshness>;
	maxPages: number;
	maxReached: boolean;
	summaryPath: string;
	manifestPath: string;
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
	injectionSignals?: CorpusPage["injectionSignals"];
};

type FetchQuestionResult = FetchBaseResult & {
	question: string;
	citations: FetchCitation[];
	limited: boolean;
	truncated: boolean;
	pagesSkipped: number;
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
const defaultSnippets = 8;

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
			writeMismatch(error, input.json);
			return;
		}
		throw error;
	}
	if (input.json) {
		process.stdout.write(`${JSON.stringify(result)}\n`);
	} else {
		process.stdout.write(textFetchResult(result));
	}
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
		: input.freshness === "auto"
			? corpusIsStale(prior)
				? "refreshed"
				: "reused"
			: input.freshness === "reuse"
				? "reused"
				: input.freshness === "refresh"
					? "refreshed"
					: "captured";
	const progress = input.quiet || input.json ? undefined : logLine;
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
		action,
		status: summary.status,
		outputDir,
		seedUrl: summary.seedUrl,
		scope: summary.captureMode,
		counts: summaryCounts(summary),
		memory: corpusFreshness(input.freshness, action, summary, prior),
		maxPages: summary.max,
		maxReached: summary.maxReached,
		summaryPath: join(outputDir, runFiles.summary),
		manifestPath: join(outputDir, runFiles.manifest),
	};
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
					record.injectionSignals.length > 0,
			).length;
	return {
		...baseResult,
		question: input.question,
		citations: ranked.matches.map((match) => {
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
			if (match.record.injectionSignals.length) {
				citation.injectionSignals = match.record.injectionSignals;
			}
			return citation;
		}),
		limited: ranked.limited,
		truncated: ranked.truncated,
		pagesSkipped: ranked.skipped,
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

function textFetchResult(result: FetchResult): string {
	const counts = result.counts;
	const lines = [
		`docsnap: ${result.action} ${counts.written} page${counts.written === 1 ? "" : "s"} in ${result.outputDir}`,
		`docsnap: status ${result.status}; scope ${result.scope}; failed ${counts.failed}; low-quality ${counts.lowQuality}; injection-signals ${counts.injectionSignalPages}`,
		`docsnap: freshness ${result.memory.decision}; age ${result.memory.ageSeconds}s; stale ${result.memory.stale}`,
	];
	if (result.failureKind || result.error) {
		lines.push(
			`docsnap: failure ${result.failureKind ?? "unknown"}${result.error ? `: ${result.error}` : ""}`,
		);
	}
	if ("citations" in result) {
		lines.push(
			`docsnap: ${result.citations.length} citation${result.citations.length === 1 ? "" : "s"} for ${JSON.stringify(result.question)}`,
		);
		for (const citation of result.citations) {
			lines.push(
				"",
				citation.citationId,
				`path: ${citation.path}`,
				`lines: ${citation.lineStart}-${citation.lineEnd}`,
				`url: ${citation.url}`,
			);
			if (citation.kind) lines.push(`kind: ${citation.kind}`);
			if (citation.injectionSignals?.length) {
				lines.push(`injectionSignals: ${citation.injectionSignals.join(", ")}`);
			}
			lines.push("", citation.snippet.trimEnd());
		}
	} else if (result.pages.length) {
		lines.push("docsnap: pages");
		for (const page of result.pages) {
			lines.push(
				`- ${page.path}${page.title ? ` (${page.title.replace(/\s+/g, " ").trim()})` : ""}: ${page.url}`,
			);
		}
	}
	lines.push(`docsnap: summary ${result.summaryPath}`);
	return terminalText(`${lines.join("\n")}\n`);
}

function writeMismatch(error: CorpusMismatchError, json: boolean): void {
	const result = {
		ok: false,
		status: "error",
		failureKind: error.failureKind,
		error: error.message,
		counts: error.counts,
		outputDir: error.outputDir,
		existingSeedUrl: error.existingSeedUrl,
		requestedUrl: error.requestedSeedUrl,
	};
	if (json) {
		process.stdout.write(`${JSON.stringify(result)}\n`);
	} else {
		process.stderr.write(
			terminalText(
				`docsnap: ${result.failureKind}: ${result.error}\ndocsnap: counts written=${result.counts.written} failed=${result.counts.failed}\n`,
			),
		);
	}
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
		!runSucceeded(summary) ||
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
	if (!runSucceeded(summary) || !enoughPages) return false;
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
