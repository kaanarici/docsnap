import { readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { isInsideOrSame, resolveSafeRelativePath } from "../core/fs-safety.ts";
import {
	identityKeyGroups,
	type identityKeys,
	identityUrls,
} from "../core/identity.ts";
import { hashContent } from "../core/snapshot.ts";
import type {
	ConditionalRequest,
	DiscoverySource,
	PageExtractor,
	PageSuccess,
	PipelineConfig,
	RunSummary,
} from "../core/types.ts";
import { filterInjectionSignals } from "../core/types.ts";
import { scanMarkdownForInjectionSignals } from "../security/injection.ts";
import { runFiles } from "./files.ts";

export type PriorPage = Omit<PageSuccess, "markdown" | "rendered"> & {
	outputPath: string;
	outputHash?: string;
};

export type PriorState = {
	enabled: boolean;
	reason?: "clean" | "missing_manifest" | "invalid_manifest";
	records: PriorPage[];
	find(input: Parameters<typeof identityKeys>[0]): PriorPage | undefined;
};

type OutputRoot = { outDir: string };

export async function loadPrior(config: PipelineConfig): Promise<PriorState> {
	if (config.clean) return disabled("clean");
	try {
		const [text, summaryText] = await Promise.all([
			readFile(join(config.outDir, runFiles.manifest), "utf8"),
			readFile(join(config.outDir, runFiles.summary), "utf8"),
		]);
		const records = parsePriorManifest(text, config);
		if (!priorMatchesSummary(summaryText, records)) {
			throw new Error("manifest and summary disagree");
		}
		return enabled(records);
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") {
			return disabled("missing_manifest");
		}
		return disabled("invalid_manifest");
	}
}

export function conditionalRequestForPrior(
	prior: PriorState,
	input: Parameters<typeof identityKeys>[0],
): ConditionalRequest | undefined {
	if (!prior.enabled) return undefined;
	const record = prior.find(input);
	if (!record || (!record.etag && !record.lastModified)) return undefined;
	return {
		...(record.etag ? { etag: record.etag } : {}),
		...(record.lastModified ? { lastModified: record.lastModified } : {}),
		urls: identityUrls(record),
	};
}

export async function recoverPriorPage(
	config: PipelineConfig,
	prior: PriorPage,
	updates: {
		fetchMs: number;
		etag?: string;
		lastModified?: string;
		fetchedAt?: string;
	},
): Promise<PageSuccess | undefined> {
	const rendered = await readPriorOutput(config, prior.outputPath);
	if (!rendered) return undefined;
	if (prior.outputHash && hashContent(rendered) !== prior.outputHash) {
		return undefined;
	}
	const markdown = markdownFromRendered(rendered);
	if (hashContent(markdown) !== prior.contentHash) return undefined;
	const { outputHash, ...record } = prior;
	void outputHash;
	const recoveredSignals = filterInjectionSignals([
		...record.injectionSignals,
		...scanMarkdownForInjectionSignals(markdown),
	]);
	const etag = updates.etag ?? record.etag;
	const lastModified = updates.lastModified ?? record.lastModified;
	return {
		...record,
		redirects: record.redirects ?? [],
		qualityReasons: record.qualityReasons ?? [],
		links: record.links ?? [],
		injectionSignals: recoveredSignals,
		markdown,
		...(etag ? { etag } : {}),
		...(lastModified ? { lastModified } : {}),
		fetchedAt:
			record.fetchedAt ?? updates.fetchedAt ?? new Date().toISOString(),
		timings: {
			fetchMs: updates.fetchMs,
			extractMs: 0,
			writeMs: 0,
		},
	};
}

export function resolvePriorOutputPath(
	config: OutputRoot,
	outputPath: string,
): string | undefined {
	return resolveSafeRelativePath(config.outDir, outputPath);
}

export async function readPriorOutput(
	config: OutputRoot,
	outputPath: string,
): Promise<string | undefined> {
	const priorPath = resolvePriorOutputPath(config, outputPath);
	if (!priorPath) return undefined;
	try {
		const [base, target] = await Promise.all([
			realpath(config.outDir),
			realpath(priorPath),
		]);
		if (!isInsideOrSame(base, target)) return undefined;
		return await readFile(target, "utf8");
	} catch {
		return undefined;
	}
}

function enabled(records: PriorPage[]): PriorState {
	const index = buildIndex(records);
	return {
		enabled: true,
		records,
		find: (input) => findPrior(index, input),
	};
}

function disabled(reason: NonNullable<PriorState["reason"]>): PriorState {
	return {
		enabled: false,
		reason,
		records: [],
		find: () => undefined,
	};
}

function parsePriorManifest(text: string, config: PipelineConfig): PriorPage[] {
	const lines = text.split(/\n/).filter((line) => line.trim());
	const pages: PriorPage[] = [];
	for (const line of lines) {
		const record = JSON.parse(line) as unknown;
		if (!isManifestRecord(record)) throw new Error("invalid manifest record");
		if (isReusablePrior(record, config)) pages.push(normalizePrior(record));
	}
	return pages;
}

function priorMatchesSummary(
	summaryText: string,
	records: PriorPage[],
): boolean {
	const summary = JSON.parse(summaryText) as Partial<RunSummary>;
	if (typeof summary.written !== "number") return false;
	if (summary.written !== records.length) return false;
	const seedPath = summary.seed?.outputPath;
	return (
		typeof seedPath !== "string" ||
		records.some((record) => record.outputPath === seedPath)
	);
}

function isManifestRecord(value: unknown): value is { ok: boolean } {
	return Boolean(value && typeof value === "object" && "ok" in value);
}

function isReusablePrior(
	value: { ok: boolean },
	config: PipelineConfig,
): value is PriorPage {
	const record = value as Partial<PriorPage>;
	return (
		record.ok === true &&
		typeof record.url === "string" &&
		typeof record.finalUrl === "string" &&
		typeof record.outputPath === "string" &&
		resolvePriorOutputPath(config, record.outputPath) !== undefined &&
		typeof record.contentHash === "string" &&
		typeof record.status === "number" &&
		isDiscoverySource(record.source) &&
		isPageExtractor(record.extractor) &&
		typeof record.confidence === "number"
	);
}

function normalizePrior(record: PriorPage): PriorPage {
	return {
		...record,
		links: Array.isArray(record.links) ? record.links : [],
		qualityReasons: Array.isArray(record.qualityReasons)
			? record.qualityReasons
			: [],
		injectionSignals: filterInjectionSignals(record.injectionSignals),
		redirects: Array.isArray(record.redirects) ? record.redirects : [],
	};
}

function isDiscoverySource(value: unknown): value is DiscoverySource {
	return (
		value === "seed" ||
		value === "llms" ||
		value === "sitemap" ||
		value === "feed" ||
		value === "nav" ||
		value === "crawl" ||
		value === "asset"
	);
}

function isPageExtractor(value: unknown): value is PageExtractor {
	return (
		value === "markdown" ||
		value === "html" ||
		value === "text" ||
		value === "inline-state" ||
		value === "fallback" ||
		value === "structured"
	);
}

type PriorIndex = {
	exact: Map<string, PriorPage>;
	route: Map<string, PriorPage>;
	ambiguousExact: Set<string>;
	ambiguousRoute: Set<string>;
};

function buildIndex(records: PriorPage[]): PriorIndex {
	const exact = new Map<string, PriorPage>();
	const route = new Map<string, PriorPage>();
	const ambiguousExact = new Set<string>();
	const ambiguousRoute = new Set<string>();
	for (const record of records) {
		const keys = identityKeyGroups(record);
		for (const key of keys.exact) indexPage(exact, ambiguousExact, key, record);
		for (const key of keys.route) indexPage(route, ambiguousRoute, key, record);
	}
	return { exact, route, ambiguousExact, ambiguousRoute };
}

function indexPage(
	index: Map<string, PriorPage>,
	ambiguous: Set<string>,
	key: string,
	record: PriorPage,
) {
	if (ambiguous.has(key)) return;
	const existing = index.get(key);
	if (!existing) index.set(key, record);
	else if (existing !== record) {
		index.delete(key);
		ambiguous.add(key);
	}
}

function findPrior(
	index: PriorIndex,
	input: Parameters<typeof identityKeys>[0],
): PriorPage | undefined {
	const keys = identityKeyGroups(input);
	for (const key of keys.exact) {
		if (index.ambiguousExact.has(key)) continue;
		const record = index.exact.get(key);
		if (record) return record;
	}
	for (const key of keys.route) {
		if (index.ambiguousRoute.has(key)) continue;
		const record = index.route.get(key);
		if (record) return record;
	}
	return undefined;
}

export function markdownFromRendered(rendered: string): string {
	if (!rendered.startsWith("---\n")) return stripOneTrailingNewline(rendered);
	const end = rendered.indexOf("\n---\n", 4);
	if (end < 0) return stripOneTrailingNewline(rendered);
	return stripOneTrailingNewline(rendered.slice(end + 5));
}

function stripOneTrailingNewline(value: string) {
	return value.endsWith("\n") ? value.slice(0, -1) : value;
}
