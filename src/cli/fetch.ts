import { join } from "node:path";
import { citationId } from "../core/citation.ts";
import { buildPipelineConfig } from "../core/config.ts";
import {
	corpusFreshness,
	corpusIsStale,
	type FreshnessDecision,
} from "../core/freshness.ts";
import type { FailureKind, PipelineConfig, RunSummary } from "../core/types.ts";
import { runSucceeded } from "../core/types.ts";
import {
	canonicalUrlSearch,
	classifyDiscoveryResource,
	looksLikeSpecificContentUrl,
} from "../core/url.ts";
import {
	type CorpusPage,
	listAllCorpora,
	manifestMatchesSummary,
	readSummary,
	readVerifiedManifest,
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
	injectionSignals?: CorpusPage["injectionSignals"];
};

type FetchPagesResult = FetchBaseResult & { pages: FetchPage[] };
type FetchResult = FetchQuestionResult | FetchPagesResult;

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
	const outputDir = await cliOutputDir(input, requestedOutputDir, base);
	const existing = await existingCorpus(
		outputDir,
		requested,
		input.freshness === "force",
	);
	const action = decideAction(input.freshness, existing);
	const progress = input.quiet || input.json ? undefined : logLine;
	const summary =
		action === "reused" && existing
			? existing
			: await capture(input, base, outputDir, action, existing, progress);
	const baseResult = resultBase(
		summary,
		action,
		outputDir,
		existing,
		input.freshness,
	);
	if (!input.question) {
		return { ...baseResult, pages: await topPages(outputDir, input.url) };
	}
	const verified = await readVerifiedManifest(outputDir);
	const ranked = await searchCorpus(outputDir, {
		query: input.question,
		maxResults: defaultSnippets,
		snippetChars: input.contextChars,
		excludeInjection: !input.includeInjection,
		preferredOutputPaths: matchingOutputPaths(verified.records, input.url),
		records: verified.records,
	});
	const injectionFiltered = input.includeInjection
		? 0
		: verified.records.filter(
				(record) =>
					record.ok &&
					Boolean(record.outputPath) &&
					record.injectionSignals.length > 0,
			).length;
	return {
		...baseResult,
		question: input.question,
		citations: ranked.matches.map((match) => ({
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
			...(match.record.injectionSignals.length
				? { injectionSignals: match.record.injectionSignals }
				: {}),
		})),
		limited: ranked.limited,
		truncated: ranked.truncated,
		pagesSkipped: ranked.skipped,
		injectionFiltered,
	};
}

async function capture(
	input: FetchInput,
	base: PipelineConfig,
	outputDir: string,
	action: FreshnessDecision,
	existing: RunSummary | null,
	progress: ((message: string) => void) | undefined,
): Promise<RunSummary> {
	const config =
		action === "refreshed" && existing
			? refreshConfig(input, existing, outputDir)
			: { ...base, outDir: outputDir };
	if (action === "captured" && input.freshness === "force") config.clean = true;
	const { runPipeline } = await import("../core/pipeline.ts");
	return (await runPipeline(config, progress)).summary;
}

function refreshConfig(
	input: FetchInput,
	prior: RunSummary,
	outputDir: string,
): PipelineConfig {
	return buildPipelineConfig({
		seedUrl: prior.seedUrl,
		outDir: outputDir,
		max: input.maxPages ?? prior.max,
		maxExplicit:
			input.maxPages !== undefined ? true : prior.maxAppliesTo === "all",
		pageOnly: prior.captureMode === "page",
		userAgent: prior.userAgent,
		cache: input.cache,
	});
}

function resultBase(
	summary: RunSummary,
	action: FreshnessDecision,
	outputDir: string,
	existing: RunSummary | null,
	freshness: FetchInput["freshness"],
): FetchBaseResult {
	return {
		ok: runSucceeded(summary),
		action,
		status: summary.status,
		outputDir,
		seedUrl: summary.seedUrl,
		scope: summary.captureMode,
		counts: summaryCounts(summary),
		memory: corpusFreshness(freshness, action, summary, existing),
		maxPages: summary.max,
		maxReached: summary.maxReached,
		summaryPath: join(outputDir, runFiles.summary),
		manifestPath: join(outputDir, runFiles.manifest),
		...(summary.seed.failureKind
			? { failureKind: summary.seed.failureKind }
			: {}),
		...(summary.seed.error ? { error: summary.seed.error } : {}),
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
	return `${lines.join("\n")}\n`;
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
			`docsnap: ${result.failureKind}: ${result.error}\ndocsnap: counts written=${result.counts.written} failed=${result.counts.failed}\n`,
		);
	}
	process.exitCode = 1;
}

async function cliOutputDir(
	input: FetchInput,
	outputDir: string,
	requested: PipelineConfig,
): Promise<string> {
	if (input.outputDir || input.question || input.freshness === "force") {
		return outputDir;
	}
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

async function existingCorpus(
	outputDir: string,
	requested: PipelineConfig,
	allowReplace: boolean,
): Promise<RunSummary | null> {
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

export function canReuseCorpus(
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
		normalizeUrl(summary.seedUrl) === normalizeUrl(requested.seedUrl)
	) {
		return true;
	}
	return corpusContainsUrl(records, requested.seedUrl);
}

function corpusContainsUrl(
	records: CorpusPage[],
	requestedUrl: string,
): boolean {
	const candidates = normalizedUrlVariants(requestedUrl);
	return records.some(
		(record) =>
			record.ok && record.outputPath && pageMatchesUrl(record, candidates),
	);
}

export function canReplaceCorpus(
	summary: RunSummary,
	requested: PipelineConfig,
	allowReplace: boolean,
): boolean {
	return (
		allowReplace ||
		!runSucceeded(summary) ||
		(summary.seedUrl === requested.seedUrl &&
			summary.captureMode === (requested.pageOnly ? "page" : "site"))
	);
}

export function throwCorpusMismatch(
	outputDir: string,
	summary: RunSummary,
	requested: PipelineConfig,
): never {
	throw mismatchError(outputDir, summary, requested.seedUrl);
}

function mismatchError(
	outputDir: string,
	summary: RunSummary,
	requestedUrl: string,
) {
	return new CorpusMismatchError(
		outputDir,
		summary.seedUrl,
		requestedUrl,
		summaryCounts(summary),
	);
}

function decideAction(
	freshness: FetchInput["freshness"],
	existing: RunSummary | null,
): FreshnessDecision {
	if (!existing) return "captured";
	if (freshness === "auto") {
		return corpusIsStale(existing) ? "refreshed" : "reused";
	}
	if (freshness === "reuse") return "reused";
	if (freshness === "refresh") return "refreshed";
	return "captured";
}

function buildBaseConfig(input: FetchInput, scope: FetchScope): PipelineConfig {
	const max = captureMax(input, scope);
	return buildPipelineConfig({
		seedUrl: input.url,
		pageOnly: scope === "page",
		site: scope === "site",
		...(max !== undefined ? { max } : {}),
		maxExplicit: max !== undefined,
		cache: input.cache,
	});
}

function captureMax(input: FetchInput, scope: FetchScope): number | undefined {
	if (scope === "page") return 1;
	if (input.maxPages !== undefined) return input.maxPages;
	if (input.scope === "auto") return autoSiteCap;
	return undefined;
}

function resolveScope(input: FetchInput): FetchScope {
	if (input.scope === "page") return "page";
	if (input.scope === "site") return "site";
	if (classifyDiscoveryResource(input.url)?.source === "llms") return "site";
	if (input.question && /\/(?:[?#].*)?$/.test(input.url)) return "site";
	return looksLikeSpecificContentUrl(input.url) ? "page" : "site";
}

function matchingOutputPaths(
	records: CorpusPage[],
	requestedUrl: string,
): string[] {
	const candidates = normalizedUrlVariants(requestedUrl);
	return records.flatMap((record) =>
		record.ok && record.outputPath && pageMatchesUrl(record, candidates)
			? [record.outputPath]
			: [],
	);
}

async function topPages(
	outputDir: string,
	requestedUrl: string,
): Promise<FetchPage[]> {
	const records = (await readVerifiedManifest(outputDir)).records.filter(
		(record): record is CorpusPage & { outputPath: string } =>
			record.ok && Boolean(record.outputPath),
	);
	const candidates = normalizedUrlVariants(requestedUrl);
	const requested = records.find((record) =>
		pageMatchesUrl(record, candidates),
	);
	return [
		...(requested ? [requested] : []),
		...records.filter((record) => record !== requested),
	]
		.slice(0, topPagesLimit)
		.map((page) => ({
			path: page.outputPath,
			url: page.url,
			...(page.title ? { title: page.title } : {}),
			...(page.injectionSignals.length
				? { injectionSignals: page.injectionSignals }
				: {}),
		}));
}

function normalizedUrlVariants(raw: string): Set<string> {
	const base = normalizeUrl(raw);
	const variants = new Set([base]);
	try {
		const url = new URL(base);
		const path = url.pathname;
		if (!hasExtension(path)) {
			addPathVariant(variants, url, `${path}.md`);
			addPathVariant(variants, url, `${path}.html`);
		} else if (/\.(?:html?|mdx?)$/i.test(path)) {
			addPathVariant(variants, url, path.replace(/\.(?:html?|mdx?)$/i, ""));
		}
	} catch {}
	return variants;
}

function addPathVariant(
	variants: Set<string>,
	base: URL,
	pathname: string,
): void {
	const url = new URL(base.href);
	url.pathname = pathname || "/";
	variants.add(normalizeUrl(url.href));
}

function normalizeUrl(raw: string): string {
	try {
		const url = new URL(raw);
		url.hash = "";
		url.pathname = url.pathname.replace(/\/{2,}/g, "/");
		if (url.pathname.length > 1) {
			url.pathname = url.pathname.replace(/\/+$/g, "");
		}
		url.search = canonicalUrlSearch(url);
		return url.href;
	} catch {
		return raw;
	}
}

function hasExtension(pathname: string): boolean {
	return /\.[a-z0-9]+$/i.test(pathname.split("/").at(-1) ?? "");
}

function pageMatchesUrl(record: CorpusPage, candidates: Set<string>) {
	return [record.url, record.finalUrl, ...(record.aliases ?? [])].some((url) =>
		candidates.has(normalizeUrl(url)),
	);
}
