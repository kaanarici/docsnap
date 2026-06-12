import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, parse, relative, resolve } from "node:path";
import {
	identityKeyGroups,
	type identityKeys,
	identityUrls,
} from "../core/identity.ts";
import { hashContent } from "../core/snapshot.ts";
import type {
	ConditionalRequest,
	Config,
	DiscoverySource,
	PageExtractor,
	PageSuccess,
} from "../core/types.ts";
import { injectionSignals } from "../core/types.ts";
import { scanMarkdownForInjectionSignals } from "../security/injection.ts";
import { runFiles } from "./files.ts";

export type PriorPage = Omit<PageSuccess, "markdown"> & {
	outputPath: string;
	outputHash?: string;
	bytes?: number;
	contentBytes?: number;
};

export type PriorState = {
	enabled: boolean;
	reason?: "clean" | "missing_manifest" | "invalid_manifest";
	records: PriorPage[];
	find(input: Parameters<typeof identityKeys>[0]): PriorPage | undefined;
};

export async function loadPrior(config: Config): Promise<PriorState> {
	if (config.clean) return disabled("clean");
	try {
		const text = await readFile(join(config.outDir, runFiles.manifest), "utf8");
		const records = parsePriorManifest(text, config);
		return enabled(records);
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") {
			return disabled("missing_manifest");
		}
		return disabled("invalid_manifest");
	}
}

export function conditionalForPrior(
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
	config: Config,
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
	const { bytes, contentBytes, outputHash, ...record } = prior;
	void bytes;
	void contentBytes;
	void outputHash;
	const recoveredSignals = cleanInjectionSignals([
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
	config: Config,
	outputPath: string,
): string | undefined {
	if (!isSafeRelativeOutputPath(outputPath)) return undefined;
	const base = resolve(config.outDir);
	const target = resolve(base, outputPath);
	return isInsideOrSame(base, target) ? target : undefined;
}

export async function readPriorOutput(
	config: Config,
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

function parsePriorManifest(text: string, config: Config): PriorPage[] {
	const lines = text.split(/\n/).filter((line) => line.trim());
	const out: PriorPage[] = [];
	for (const line of lines) {
		const record = JSON.parse(line) as unknown;
		if (!isManifestRecord(record)) throw new Error("invalid manifest record");
		if (isReusablePrior(record, config)) out.push(normalizePrior(record));
	}
	return out;
}

function isManifestRecord(value: unknown): value is { ok: boolean } {
	return Boolean(value && typeof value === "object" && "ok" in value);
}

function isReusablePrior(
	value: { ok: boolean },
	config: Config,
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
		isSource(record.source) &&
		isExtractor(record.extractor) &&
		typeof record.confidence === "number" &&
		Array.isArray(record.links) &&
		Array.isArray(record.qualityReasons)
	);
}

function normalizePrior(record: PriorPage): PriorPage {
	return {
		...record,
		injectionSignals: cleanInjectionSignals(record.injectionSignals),
	};
}

function cleanInjectionSignals(value: unknown) {
	const allowed = new Set(injectionSignals);
	return Array.isArray(value)
		? value.filter((item): item is PriorPage["injectionSignals"][number] =>
				allowed.has(item),
			)
		: [];
}

function isSafeRelativeOutputPath(outputPath: string) {
	return (
		outputPath.trim() !== "" &&
		!isAbsolute(outputPath) &&
		!isWindowsAbsolute(outputPath) &&
		!outputPath.split(/[\\/]+/).includes("..")
	);
}

function isWindowsAbsolute(outputPath: string) {
	return /^[a-zA-Z]:[\\/]/.test(outputPath) || outputPath.startsWith("\\\\");
}

function isInsideOrSame(parent: string, child: string) {
	const path = relative(parent, child);
	return path === "" || (!path.startsWith("..") && !parse(path).root);
}

function isSource(value: unknown): value is DiscoverySource {
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

function isExtractor(value: unknown): value is PageExtractor {
	return (
		value === "markdown" ||
		value === "html" ||
		value === "text" ||
		value === "fallback"
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
		for (const key of keys.exact) addIndex(exact, ambiguousExact, key, record);
		for (const key of keys.route) addIndex(route, ambiguousRoute, key, record);
	}
	return { exact, route, ambiguousExact, ambiguousRoute };
}

function addIndex(
	index: Map<string, PriorPage>,
	ambiguous: Set<string>,
	key: string,
	record: PriorPage,
) {
	if (ambiguous.has(key)) return;
	const current = index.get(key);
	if (!current) index.set(key, record);
	else if (current !== record) {
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

function markdownFromRendered(rendered: string) {
	if (!rendered.startsWith("---\n")) return stripOneTrailingNewline(rendered);
	const end = rendered.indexOf("\n---\n", 4);
	if (end < 0) return stripOneTrailingNewline(rendered);
	return stripOneTrailingNewline(rendered.slice(end + 5));
}

function stripOneTrailingNewline(value: string) {
	return value.endsWith("\n") ? value.slice(0, -1) : value;
}
