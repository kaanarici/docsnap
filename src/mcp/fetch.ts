import { buildPipelineConfig, nextCaptureMax } from "../core/config.ts";
import {
	corpusFreshness,
	corpusIsStale,
	type FreshnessDecision,
} from "../core/freshness.ts";
import { runPipeline } from "../core/pipeline.ts";
import {
	canBroadenAfterFailure,
	canRetryAfterFailure,
	type PipelineConfig,
	type RunSummary,
	runSucceeded,
} from "../core/types.ts";
import {
	canonicalUrlSearch,
	classifyDiscoveryResource,
	looksLikeSpecificContentUrl,
	siteDiscoverySeedUrl,
} from "../core/url.ts";
import {
	type McpState,
	readableCorpusDir,
	rememberCorpus,
	writableCorpusDir,
} from "./access.ts";
import { buildContextPack } from "./context-pack.ts";
import {
	type CorpusPage,
	listPages,
	manifestMatchesSummary,
	readSummary,
	readVerifiedManifest,
} from "./corpus.ts";
import type { FetchToolInput } from "./inputs.ts";
import { mcpCorpusInfo, mcpWarnings } from "./results.ts";

export type FetchToolDeps = {
	progress: (message: string) => void;
	resolveOutputDir?: (
		outputDir: string,
		requested: PipelineConfig,
	) => Promise<string>;
	readExistingSummary?: (
		outputDir: string,
		state: McpState,
		requested: PipelineConfig,
		allowReplace: boolean,
	) => Promise<RunSummary | null>;
};

export type FetchScope = "page" | "site";

const topPagesLimit = 10;
const autoSiteCap = 25;
const defaultSnippets = 8;

export class CorpusMismatchError extends Error {
	constructor(
		readonly outputDir: string,
		readonly existingSeedUrl: string,
		readonly requestedSeedUrl: string,
	) {
		super(
			`Existing corpus at ${outputDir} was captured from ${existingSeedUrl} and does not contain ${requestedSeedUrl}.`,
		);
		this.name = "CorpusMismatchError";
	}
}

export async function runFetchTool(
	input: FetchToolInput,
	deps: FetchToolDeps,
	state: McpState,
) {
	const scope = resolveScope(input);
	const base = buildBaseConfig(input, scope);
	const requestedOutputDir = input.output_dir ?? base.outDir;
	const outputDir = deps.resolveOutputDir
		? await deps.resolveOutputDir(requestedOutputDir, base)
		: await writableCorpusDir(requestedOutputDir);
	const existing = await existingCorpus(
		outputDir,
		state,
		base,
		deps,
		input.freshness === "force",
	);
	const action = decideAction(input.freshness, existing);

	const summary =
		action === "reused" && existing
			? existing
			: await capture(input, base, outputDir, action, existing, deps);
	rememberCorpus(state, outputDir);

	const ok = runSucceeded(summary);
	const corpus = corpusInfo(summary, action, outputDir);
	const memory = corpusFreshness(input.freshness, action, summary, existing);
	const warnings = mcpWarnings(summary);
	const limits = {
		max_pages: summary.max,
		max_reached: summary.maxReached,
	};
	if (input.question) {
		const pack = await buildContextPack(outputDir, {
			query: input.question,
			maxSnippets: defaultSnippets,
			contextChars: input.context_chars,
			excludeInjection: input.safety === "exclude_injection",
			preferredOutputPaths: await matchingOutputPaths(outputDir, input.url),
			...(summary.maxReached ? { coverageAction: false as const } : {}),
		});
		return {
			ok,
			corpus,
			memory,
			warnings,
			limits,
			question: input.question,
			citation_count: pack.citation_count,
			injection_excluded: pack.injection_excluded,
			citations: pack.citations,
			truncated: pack.truncated,
			limited: pack.limited,
			pages_skipped: pack.pages_skipped,
			next_actions: [
				...fetchNextActions(summary, false, input.question),
				...pack.next_actions,
			],
		};
	}
	return {
		ok,
		corpus,
		memory,
		warnings,
		limits,
		top_pages: await topPages(outputDir, input.url),
		next_actions: fetchNextActions(summary, true),
	};
}

async function matchingOutputPaths(outputDir: string, requestedUrl: string) {
	try {
		const candidates = normalizedUrlVariants(requestedUrl);
		return (await readVerifiedManifest(outputDir)).records.flatMap((record) =>
			record.ok && record.outputPath && pageMatchesUrl(record, candidates)
				? [record.outputPath]
				: [],
		);
	} catch {
		return [];
	}
}

async function capture(
	input: FetchToolInput,
	base: PipelineConfig,
	outputDir: string,
	action: FreshnessDecision,
	existing: RunSummary | null,
	deps: FetchToolDeps,
): Promise<RunSummary> {
	const config =
		action === "refreshed" && existing
			? refreshConfig(input, existing, outputDir)
			: { ...base, outDir: outputDir };
	if (action === "captured" && input.freshness === "force") config.clean = true;
	const result = await runPipeline(config, deps.progress);
	return result.summary;
}

function refreshConfig(
	input: FetchToolInput,
	prior: RunSummary,
	outputDir: string,
): PipelineConfig {
	return buildPipelineConfig({
		seedUrl: prior.seedUrl,
		outDir: outputDir,
		max: input.max_pages ?? prior.max,
		maxExplicit:
			input.max_pages !== undefined ? true : prior.maxAppliesTo === "all",
		pageOnly: prior.captureMode === "page",
		userAgent: prior.userAgent,
		...(input.cache !== undefined ? { cache: input.cache } : {}),
	});
}

function decideAction(
	freshness: FetchToolInput["freshness"],
	existing: RunSummary | null,
): FreshnessDecision {
	if (!existing) return "captured";
	if (freshness === "auto")
		return corpusIsStale(existing) ? "refreshed" : "reused";
	if (freshness === "reuse") return "reused";
	if (freshness === "refresh") return "refreshed";
	return "captured";
}

async function existingCorpus(
	outputDir: string,
	state: McpState,
	requested: PipelineConfig,
	deps: FetchToolDeps,
	allowReplace: boolean,
): Promise<RunSummary | null> {
	if (deps.readExistingSummary) {
		return deps.readExistingSummary(outputDir, state, requested, allowReplace);
	}
	let dir: string;
	let summary: RunSummary;
	let records: CorpusPage[];
	try {
		dir = await readableCorpusDir(outputDir, state.corpora);
		summary = await readSummary(dir);
	} catch {
		return null;
	}
	try {
		records = (await readVerifiedManifest(dir, summary)).records;
	} catch {
		if (canReplaceCorpus(summary, requested, allowReplace)) return null;
		throw new Error(`Invalid manifest in existing corpus: ${dir}`);
	}
	if (canReuseCorpus(summary, requested, records)) return summary;
	return canReplaceCorpus(summary, requested, allowReplace)
		? null
		: throwCorpusMismatch(dir, summary, requested);
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
	throw new CorpusMismatchError(outputDir, summary.seedUrl, requested.seedUrl);
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
	} catch {
		// Keep the exact string when URL metadata is malformed.
	}
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
		if (url.pathname.length > 1)
			url.pathname = url.pathname.replace(/\/+$/g, "");
		url.search = canonicalUrlSearch(url);
		return url.href;
	} catch {
		return raw;
	}
}

function hasExtension(pathname: string): boolean {
	return /\.[a-z0-9]+$/i.test(pathname.split("/").at(-1) ?? "");
}

function buildBaseConfig(
	input: FetchToolInput,
	scope: FetchScope,
): PipelineConfig {
	const max = captureMax(input, scope);
	return buildPipelineConfig({
		seedUrl: input.url,
		pageOnly: scope === "page",
		site: scope === "site",
		...(max !== undefined ? { max } : {}),
		maxExplicit: input.max_pages !== undefined,
		...(input.cache !== undefined ? { cache: input.cache } : {}),
	});
}

function captureMax(
	input: FetchToolInput,
	scope: FetchScope,
): number | undefined {
	if (scope === "page") return 1;
	if (input.max_pages !== undefined) return input.max_pages;
	if (input.scope === "auto" || input.scope === undefined) return autoSiteCap;
	return undefined;
}

function resolveScope(input: FetchToolInput): FetchScope {
	if (input.scope === "page") return "page";
	if (input.scope === "site") return "site";
	if (classifyDiscoveryResource(input.url)?.source === "llms") return "site";
	return looksLikeSpecificContentUrl(input.url) ? "page" : "site";
}

function corpusInfo(
	summary: RunSummary,
	action: FreshnessDecision,
	outputDir: string,
) {
	const { paths, ...corpus } = mcpCorpusInfo(summary, { outputDir });
	return {
		action,
		scope: summary.captureMode,
		...corpus,
		status: summary.status,
		written: summary.written,
		failed: summary.failed,
		seed_included: summary.seed.included,
		injection_signal_pages: summary.injectionSignalPages,
		paths,
	};
}

function fetchNextActions(
	summary: RunSummary,
	includeQuestionPrompt: boolean,
	question?: string,
): string[] {
	const actions: string[] = [];
	if (!runSucceeded(summary)) {
		actions.push(
			"Inspect docsnap_get_corpus_summary before using this corpus; the requested URL was not captured as the seed page.",
		);
		if (summary.written > 0) {
			actions.push(
				"Search adjacent captured pages only if they are still relevant to the task.",
			);
		} else {
			const canRetry = canRetryAfterFailure(summary.seed.failureKind);
			const canTrySite =
				summary.captureMode === "page" &&
				canBroadenAfterFailure(summary.seed.failureKind);
			if (canRetry) {
				actions.push(
					`Retry after inspecting with docsnap_fetch ${JSON.stringify(fetchArgs(summary, summary.captureMode === "site" ? summary.max : undefined, question))}.`,
				);
			}
			if (canTrySite) {
				actions.push(
					`If the exact page URL is too narrow, try site scope with docsnap_fetch ${JSON.stringify(fetchSiteArgs(summary, question))}.`,
				);
			}
			if (!canRetry && !canTrySite) {
				actions.push(
					"Choose another reachable public docs URL after inspecting the failure kind.",
				);
			}
		}
		return actions;
	}
	if (summary.maxReached) {
		const nextMax = nextCaptureMax(summary.max);
		if (nextMax !== undefined) {
			actions.push(
				`Call docsnap_fetch ${JSON.stringify(fetchArgs(summary, nextMax, question))} if you need more pages.`,
			);
		}
	}
	if (includeQuestionPrompt) {
		actions.push(
			"Call docsnap_fetch again with a question to get a ranked, cited context pack.",
			"Or run docsnap_search_corpus / docsnap_context_pack on this output_dir.",
		);
	}
	return actions;
}

function fetchArgs(summary: RunSummary, maxPages?: number, question?: string) {
	return {
		url: summary.seedUrl,
		output_dir: summary.outDir,
		scope: summary.captureMode,
		...(maxPages !== undefined ? { max_pages: maxPages } : {}),
		...(question ? { question } : {}),
	};
}
function fetchSiteArgs(summary: RunSummary, question?: string) {
	return {
		url: siteDiscoverySeedUrl(summary.seedUrl),
		output_dir: summary.outDir,
		scope: "site" as const,
		max_pages: summary.max,
		freshness: "force" as const,
		...(question ? { question } : {}),
	};
}

async function topPages(outputDir: string, requestedUrl: string) {
	try {
		const records = (await readVerifiedManifest(outputDir)).records.filter(
			(record): record is CorpusPage & { outputPath: string } =>
				record.ok && Boolean(record.outputPath),
		);
		const candidates = normalizedUrlVariants(requestedUrl);
		const requested = records.find((record) =>
			pageMatchesUrl(record, candidates),
		);
		const pages = [
			...(requested ? [requested] : []),
			...records.filter((record) => record !== requested),
		].slice(0, topPagesLimit);
		return pages.map((page) => ({
			output_path: page.outputPath,
			url: page.url,
			...(page.title ? { untrusted_web_title: page.title } : {}),
		}));
	} catch {
		const listed = await listPages(outputDir, topPagesLimit, undefined, false);
		return listed.pages.map((page) => ({
			output_path: page.output_path,
			url: page.url,
			...(page.untrusted_web_title
				? { untrusted_web_title: page.untrusted_web_title }
				: {}),
		}));
	}
}

function pageMatchesUrl(record: CorpusPage, candidates: Set<string>) {
	return [record.url, record.finalUrl, ...(record.aliases ?? [])].some((url) =>
		candidates.has(normalizeUrl(url)),
	);
}
