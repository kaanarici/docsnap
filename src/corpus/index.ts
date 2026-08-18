import { realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { defaultUserAgent, maxGeneratedCapturePages } from "../core/config.ts";
import {
	isJsonBoolean,
	isJsonNumber,
	isJsonObject,
	isJsonString,
	type JsonObject,
	type JsonValue,
	jsonEnum,
	parseJsonValue,
} from "../core/json.ts";
import { runBounded } from "../core/parallel.ts";
import { emptyRefreshSummary } from "../core/refresh.ts";
import {
	hashContent,
	snapshotLeaf,
	snapshotSchemaVersion,
	snapshotStatsFromLeaves,
} from "../core/snapshot.ts";
import {
	type DiscoverySource,
	discoverySources,
	type FailureKind,
	failureKinds,
	filterInjectionSignals,
	type InjectionSignal,
	injectionSignals,
	inlineStateSources,
	type PageExtractor,
	pageExtractors,
	type RunSummary,
} from "../core/types.ts";
import { runFiles } from "../output/files.ts";
import { markdownFromRendered, parseReusablePrior } from "../output/prior.ts";
import { buildRankInput, rankPages } from "../search/rank.ts";
import { scanMarkdownForInjectionSignals } from "../security/injection.ts";
import { maxPublicUrlChars } from "../security/url.ts";
import {
	corpusLimits,
	readBoundedCorpusFile,
	readBoundedCorpusFileFromRealRoot,
	readOptionalCorpusFileFromRealRoot,
} from "./access.ts";
import {
	maxAllSearchScannedDirs,
	type ScanOptions,
	scanCorpora,
} from "./scan.ts";

export type CorpusPage = {
	ok: boolean;
	url: string;
	finalUrl: string;
	injectionSignals: InjectionSignal[];
	aliases?: string[];
	outputPath?: string;
	title?: string;
	source?: DiscoverySource;
	confidence?: number;
	qualityReasons?: string[];
	failureKind?: FailureKind;
	error?: string;
	contentHash?: string;
	outputHash?: string;
	extractor?: PageExtractor;
	fetchedAt?: string;
};

type SearchOptions = {
	query: string;
	pathGlob?: string;
	maxResults: number;
	snippetChars: number;
	excludeInjection?: boolean;
	preferredOutputPaths?: readonly string[];
	records: CorpusPage[];
};

type CorpusFields<T> = JsonObject & Partial<Record<keyof T, JsonValue>>;
type LegacySummary = RunSummary & {
	renderedFiles: number;
	renderedBytes: number;
};

const globCache = new Map<string, Bun.Glob>();

export async function readSummary(outputDir: string): Promise<RunSummary> {
	const text = await readBoundedCorpusFile(
		outputDir,
		runFiles.summary,
		corpusLimits.summaryBytes,
	);
	try {
		const parsed = parseJsonValue(text);
		const raw = pre02Summary(parsed) ?? parsed;
		if (!isRunSummary(raw)) throw new Error("invalid summary shape");
		return raw;
	} catch {
		throw new Error(`Invalid ${runFiles.summary} in corpus`);
	}
}

function pre02Summary(value: JsonValue): JsonValue | undefined {
	if (!isCorpusFields<LegacySummary>(value) || "seed" in value)
		return undefined;
	const raw = value;
	if (
		raw.snapshotVersion !== snapshotSchemaVersion ||
		!isSha256(raw.rootHash) ||
		!isNonNegativeInteger(raw.renderedFiles) ||
		!isNonNegativeInteger(raw.renderedBytes) ||
		!isJsonString(raw.seedUrl) ||
		!isNonNegativeInteger(raw.written)
	) {
		return undefined;
	}
	const errors = Array.isArray(raw.errors) ? raw.errors : [];
	const seedFailure = errors.find(
		(error): error is JsonObject =>
			isJsonObject(error) && error["url"] === raw.seedUrl,
	);
	const failed = errors.length;
	const seed: CorpusFields<RunSummary["seed"]> = {
		attempted: true,
		included: raw.written > 0 && !seedFailure,
		url: raw.seedUrl,
	};
	if (seedFailure) {
		seed.omissionReason = "failed";
		if (isJsonString(seedFailure["kind"]))
			seed.failureKind = seedFailure["kind"];
		if (isJsonString(seedFailure["error"])) seed.error = seedFailure["error"];
	}
	return {
		status: raw.written > 0 ? (failed > 0 ? "partial" : "ok") : "failed",
		...raw,
		seed,
		warnings: [],
		outDir: isJsonString(raw.outDir) ? raw.outDir : "",
		dryRun: raw.dryRun === true,
		captureMode: "site",
		userAgent: defaultUserAgent,
		generatedAt:
			isJsonString(raw.generatedAt) &&
			Number.isFinite(Date.parse(raw.generatedAt))
				? raw.generatedAt
				: new Date(0).toISOString(),
		corpusFiles: raw.renderedFiles,
		corpusBytes: raw.renderedBytes,
		max:
			isNonNegativeInteger(raw.max) &&
			raw.max > 0 &&
			raw.max <= maxGeneratedCapturePages
				? raw.max
				: Math.max(1, Math.min(maxGeneratedCapturePages, raw.written)),
		maxAppliesTo: raw.maxAppliesTo === "all" ? "all" : "non-llms",
		maxReached: raw.maxReached === true,
		discovered: isNonNegativeInteger(raw.discovered)
			? raw.discovered
			: raw.written + failed,
		deduped: isNonNegativeInteger(raw.deduped) ? raw.deduped : 0,
		failed,
		lowQuality: isNonNegativeInteger(raw.lowQuality) ? raw.lowQuality : 0,
		qualityWarnings: isNonNegativeInteger(raw.qualityWarnings)
			? raw.qualityWarnings
			: 0,
		injectionSignalPages: 0,
		byInjectionSignal: {},
		hostRedirects: 0,
		redirectedHosts: [],
		elapsedMs:
			isJsonNumber(raw.elapsedMs) && raw.elapsedMs >= 0 ? raw.elapsedMs : 0,
		pagesPerSecond: 0,
		bySource: Object.fromEntries(discoverySources.map((source) => [source, 0])),
		byExtractor: Object.fromEntries(
			pageExtractors.map((extractor) => [extractor, 0]),
		),
		byInlineStateSource: {},
		firstPageMs: null,
		refresh: emptyRefreshSummary(),
		cache: {
			enabled: false,
			dir: null,
			...Object.fromEntries(cacheCounterFields.map((field) => [field, 0])),
		},
		errors,
		byFailureKind: isJsonObject(raw.byFailureKind) ? raw.byFailureKind : {},
	};
}

const summaryCounterFields = [
	"corpusFiles",
	"corpusBytes",
	"discovered",
	"deduped",
	"written",
	"failed",
	"lowQuality",
	"qualityWarnings",
	"injectionSignalPages",
	"hostRedirects",
] as const;

const refreshCounterFields = [
	"priorRecords",
	"checked",
	"notModified",
	"reused",
	"fallbackRefetches",
	"pageWrites",
	"skippedWrites",
	"new",
	"changed",
	"unchanged",
	"removed",
] as const;

const cacheCounterFields = [
	"hits",
	"misses",
	"stale",
	"revalidated",
	"written",
	"notStored",
	"bytesRead",
	"bytesWritten",
	"evictedBytes",
] as const;
const omissionReasons = [
	"not_discovered",
	"failed",
	"not_written",
	"empty_resource",
] as const;

function isRunSummary(value: JsonValue): value is JsonObject & RunSummary {
	return (
		isCorpusFields<RunSummary>(value) &&
		enumIncludes(["ok", "partial", "failed"], value.status) &&
		isBoundedString(value.seedUrl, maxPublicUrlChars) &&
		isSeedSummary(value.seed) &&
		isWarnings(value.warnings) &&
		isJsonString(value.outDir) &&
		isJsonBoolean(value.dryRun) &&
		enumIncludes(["page", "site"], value.captureMode) &&
		isBoundedString(value.userAgent, 1024) &&
		isTimestamp(value.generatedAt) &&
		value.snapshotVersion === snapshotSchemaVersion &&
		isSha256(value.rootHash) &&
		countersAreValid(value, summaryCounterFields) &&
		isNonNegativeInteger(value.max) &&
		value.max > 0 &&
		value.max <= maxGeneratedCapturePages &&
		enumIncludes(["all", "non-llms"], value.maxAppliesTo) &&
		isJsonBoolean(value.maxReached) &&
		(value.discoveryTruncated === undefined ||
			isJsonBoolean(value.discoveryTruncated)) &&
		(value.selectionHash === undefined || isSha256(value.selectionHash)) &&
		isCountRecord(value.byInjectionSignal, injectionSignals) &&
		isObjectArray(
			value.redirectedHosts,
			(item) =>
				isJsonString(item["from"]) &&
				isJsonString(item["to"]) &&
				isNonNegativeInteger(item["count"]),
		) &&
		isNonNegativeFinite(value.elapsedMs) &&
		(value.firstPageMs === null || isNonNegativeFinite(value.firstPageMs)) &&
		isNonNegativeFinite(value.pagesPerSecond) &&
		isCountRecord(value.bySource, discoverySources, true) &&
		isCountRecord(value.byExtractor, pageExtractors, true) &&
		isCountRecord(value.byInlineStateSource, inlineStateSources) &&
		isCountRecord(value.byFailureKind, failureKinds) &&
		isObjectArray(
			value.errors,
			(item) =>
				isJsonString(item["url"]) &&
				isJsonString(item["error"]) &&
				enumIncludes(failureKinds, item["kind"]),
		) &&
		isRefreshSummary(value.refresh) &&
		isCacheSummary(value.cache) &&
		(value.render === undefined || isRenderSummary(value.render))
	);
}

function isSeedSummary(value: JsonValue | undefined): boolean {
	return (
		isCorpusFields<RunSummary["seed"]>(value) &&
		isJsonBoolean(value.attempted) &&
		isJsonBoolean(value.included) &&
		optionalString(value.url) &&
		optionalString(value.finalUrl) &&
		(value.redirected === undefined || value.redirected === true) &&
		optionalEnum(value.source, discoverySources) &&
		optionalEnum(value.kind, ["page", "discovery_resource"]) &&
		optionalString(value.outputPath) &&
		(value.pagesWritten === undefined ||
			isNonNegativeInteger(value.pagesWritten)) &&
		optionalEnum(value.omissionReason, omissionReasons) &&
		optionalEnum(value.failureKind, failureKinds) &&
		optionalString(value.error)
	);
}

function isRefreshSummary(value: JsonValue | undefined): boolean {
	return (
		isCorpusFields<RunSummary["refresh"]>(value) &&
		isJsonBoolean(value.enabled) &&
		optionalEnum(value.reason, [
			"clean",
			"missing_manifest",
			"invalid_manifest",
		]) &&
		countersAreValid(value, refreshCounterFields) &&
		isObjectArray(
			value.changedPages,
			(page) =>
				enumIncludes(["new", "changed", "removed"], page["change"]) &&
				isBoundedString(page["url"], maxPublicUrlChars) &&
				optionalString(page["finalUrl"]) &&
				optionalString(page["outputPath"]) &&
				optionalString(page["previousOutputPath"]),
		)
	);
}

function isCacheSummary(value: JsonValue | undefined): boolean {
	return (
		isCorpusFields<RunSummary["cache"]>(value) &&
		isJsonBoolean(value.enabled) &&
		(value.dir === null || isJsonString(value.dir)) &&
		countersAreValid(value, cacheCounterFields)
	);
}

function isWarnings(value: JsonValue | undefined) {
	return isObjectArray(value, (warning) => {
		if (!isJsonString(warning["message"])) return false;
		switch (warning["kind"]) {
			case "seed_omitted":
			case "discovery_resource_empty":
				return (
					optionalEnum(warning["omissionReason"], omissionReasons) &&
					optionalEnum(warning["failureKind"], failureKinds) &&
					optionalString(warning["error"])
				);
			case "discovery_resource_seed":
				return (
					isNonNegativeInteger(warning["pagesWritten"]) &&
					optionalEnum(warning["source"], discoverySources)
				);
			case "seed_redirected":
				return (
					optionalString(warning["url"]) && optionalString(warning["finalUrl"])
				);
			default:
				return false;
		}
	});
}

function isRenderSummary(value: JsonValue | undefined) {
	if (!isJsonObject(value) || value["renderer"] !== "chrome-cdp") return false;
	return (
		countersAreValid(value, [
			"attempted",
			"rendered",
			"recovered",
			"failed",
			"blockedRequests",
			"fulfilledRequests",
			"relayedBytes",
			"skipped",
		]) &&
		isNonNegativeFinite(value["launchMs"]) &&
		isNonNegativeFinite(value["renderMs"]) &&
		isJsonBoolean(value["truncated"]) &&
		optionalEnum(value["stopReason"], ["budget", "no_recovery"]) &&
		optionalString(value["unavailable"])
	);
}

function countersAreValid(
	value: JsonObject,
	fields: readonly string[],
): boolean {
	return fields.every((field) => isNonNegativeInteger(value[field]));
}

function isCountRecord(
	value: JsonValue | undefined,
	keys: readonly string[],
	requireAll = false,
): boolean {
	if (!isJsonObject(value)) return false;
	return (
		(!requireAll || keys.every((key) => key in value)) &&
		Object.entries(value).every(
			([key, count]) => keys.includes(key) && isNonNegativeInteger(count),
		)
	);
}

function isTimestamp(value: JsonValue | undefined): value is string {
	return isBoundedString(value, 64) && Number.isFinite(Date.parse(value));
}

function isNonNegativeFinite(value: JsonValue | undefined): value is number {
	return isJsonNumber(value) && value >= 0;
}

function isBoundedString(
	value: JsonValue | undefined,
	maxLength: number,
): value is string {
	return isJsonString(value) && value.length > 0 && value.length <= maxLength;
}

function optionalString(value: JsonValue | undefined): boolean {
	return value === undefined || isJsonString(value);
}

function optionalEnum<T extends string>(
	value: JsonValue | undefined,
	values: readonly T[],
): boolean {
	return value === undefined || enumIncludes(values, value);
}

function isObjectArray(
	value: JsonValue | undefined,
	validate: (item: JsonObject) => boolean,
): boolean {
	return (
		Array.isArray(value) &&
		value.every((item) => isJsonObject(item) && validate(item))
	);
}

function enumIncludes<T extends string>(
	values: readonly T[],
	value: JsonValue | undefined,
): value is T {
	return isJsonString(value) && values.some((allowed) => allowed === value);
}

function isCorpusFields<T>(
	value: JsonValue | undefined,
): value is CorpusFields<T> {
	return isJsonObject(value);
}

async function readManifest(outputDir: string): Promise<CorpusPage[]> {
	const text = await readBoundedCorpusFile(
		outputDir,
		runFiles.manifest,
		corpusLimits.manifestBytes,
	);
	const records: CorpusPage[] = [];
	const outputPaths = new Set<string>();
	for (const line of text.split(/\n/)) {
		if (!line.trim()) continue;
		const record = parseManifestLine(line, outputDir);
		if (record.outputPath && outputPaths.has(record.outputPath)) {
			throw new Error(
				`Invalid ${runFiles.manifest} in corpus: duplicate output path`,
			);
		}
		if (record.outputPath) outputPaths.add(record.outputPath);
		records.push(record);
	}
	return records;
}

export async function readVerifiedManifest(
	outputDir: string,
	summary?: RunSummary,
): Promise<{ summary: RunSummary; records: CorpusPage[] }> {
	const current = summary ?? (await readSummary(outputDir));
	const records = await readManifest(outputDir);
	if (!manifestMatchesSummary(current, records))
		throw new Error(`Invalid ${runFiles.manifest} in corpus`);
	const retained = records.filter(
		(record): record is CorpusPage & { outputPath: string } =>
			record.ok && Boolean(record.outputPath),
	);
	if (retained.length !== current.corpusFiles)
		throw new Error(`Invalid ${runFiles.summary} in corpus`);
	const realOutputDir = await realpath(outputDir);
	const leaves = await runBounded(
		retained,
		{ concurrency: 8, perOrigin: 8, key: () => "" },
		async (record) => {
			const body = verifyPageBody(
				record,
				await readBoundedCorpusFileFromRealRoot(
					outputDir,
					realOutputDir,
					record.outputPath,
					corpusLimits.pageBytes,
				),
			);
			return snapshotLeaf(record.outputPath, body);
		},
	);
	const snapshot = snapshotStatsFromLeaves(leaves);
	if (
		snapshot.rootHash !== current.rootHash ||
		snapshot.files !== current.corpusFiles ||
		snapshot.bytes !== current.corpusBytes
	) {
		throw new Error(`Invalid ${runFiles.summary} in corpus`);
	}
	return { summary: current, records };
}

export async function listCorpora(
	rootDir: string,
	pageSize: number,
	cursor: string | undefined,
	options: ScanOptions = {},
) {
	const offset = decodeCursor(cursor);
	const scanned = await scanCorpora(rootDir, maxAllSearchScannedDirs, options);
	const entries = await runBounded(
		scanned.dirs,
		{ concurrency: 8, perOrigin: 1, key: (dir) => dir },
		async (outputDir) => {
			try {
				const { summary } = await readVerifiedManifest(outputDir);
				return corpusListEntry(summary, outputDir);
			} catch {
				return undefined;
			}
		},
	);
	const corpora = entries.filter(
		(entry): entry is ReturnType<typeof corpusListEntry> => entry !== undefined,
	);
	corpora.sort(
		(left, right) =>
			right.generated_at.localeCompare(left.generated_at) ||
			left.output_dir.localeCompare(right.output_dir),
	);
	return {
		corpora: corpora.slice(offset, offset + pageSize),
		truncated: scanned.truncated,
		corporaSkipped: scanned.skipped + (scanned.dirs.length - corpora.length),
		next_cursor:
			offset + pageSize < corpora.length
				? String(offset + pageSize)
				: undefined,
	};
}

export async function listAllCorpora(rootDir: string) {
	const scanned = await scanCorpora(rootDir, maxAllSearchScannedDirs, {
		allowAbsoluteRoot: true,
		preserveAbsolutePaths: isAbsolute(rootDir),
	});
	const outputDirs = scanned.dirs.sort((a, b) => a.localeCompare(b));
	return {
		corpora: outputDirs.map((output_dir) => ({ output_dir })),
		truncated: scanned.truncated,
		skipped: scanned.skipped,
	};
}

export async function searchCorpus(outputDir: string, options: SearchOptions) {
	const records = options.records.filter(
		(record) =>
			record.ok &&
			record.outputPath &&
			(!options.pathGlob || globMatches(options.pathGlob, record.outputPath)) &&
			(options.excludeInjection !== true ||
				record.injectionSignals.length === 0),
	);
	const realOutputDir = await realpath(outputDir);
	const { input, truncated, skipped } = await buildRankInput(
		records,
		async (record) => {
			const body = await readOptionalCorpusFileFromRealRoot(
				outputDir,
				realOutputDir,
				record.outputPath,
				corpusLimits.pageBytes,
			);
			return body === null ? null : verifyPageBody(record, body);
		},
		{ maxPages: corpusLimits.searchPages, maxBytes: corpusLimits.searchBytes },
		{ query: options.query },
	);
	const ranked = rankPages(input, options.query, {
		maxResults: options.maxResults + 1,
		snippetChars: options.snippetChars,
		preferredOutputPaths: new Set(options.preferredOutputPaths ?? []),
	});
	return {
		matches: ranked.slice(0, options.maxResults),
		truncated,
		limited: ranked.length > options.maxResults,
		skipped,
	};
}

export function manifestMatchesSummary(
	summary: RunSummary,
	records: CorpusPage[],
): boolean {
	let written = 0;
	let failed = 0;
	let seedIncluded = false;
	for (const record of records) {
		if (!record.ok) {
			failed++;
			continue;
		}
		if (!record.outputPath) continue;
		written++;
		seedIncluded ||= summary.seed.outputPath
			? record.outputPath === summary.seed.outputPath
			: summary.seed.kind === "discovery_resource" && summary.seed.source
				? record.source === summary.seed.source
				: true;
	}
	return (
		written === summary.written &&
		failed === summary.failed &&
		(!summary.seed.included || seedIncluded)
	);
}

export function globMatches(pattern: string, path: string): boolean {
	if (!globCache.has(pattern)) globCache.set(pattern, new Bun.Glob(pattern));
	return globCache.get(pattern)!.match(path);
}

function decodeCursor(cursor: string | undefined): number {
	if (cursor === undefined) return 0;
	if (!/^\d{1,8}$/.test(cursor)) throw new Error("Invalid cursor");
	const offset = Number(cursor);
	if (offset > maxAllSearchScannedDirs) throw new Error("Invalid cursor");
	return offset;
}

function parseManifestLine(line: string, outputDir: string): CorpusPage {
	let parsed: JsonValue;
	try {
		parsed = parseJsonValue(line);
	} catch {
		throw new Error(`Invalid ${runFiles.manifest} in corpus`);
	}
	if (!isCorpusFields<CorpusPage>(parsed))
		throw new Error(`Invalid ${runFiles.manifest} in corpus`);
	if (parsed.ok === true) {
		const page = parseReusablePrior(parsed, { outDir: outputDir });
		if (!page || !isSha256(page.contentHash) || !isSha256(page.outputHash)) {
			throw new Error(`Invalid ${runFiles.manifest} in corpus`);
		}
		return page;
	}
	const page: CorpusPage = {
		ok: false,
		url: stringValue(parsed.url, "url"),
		finalUrl: stringValue(parsed.finalUrl, "finalUrl"),
		injectionSignals: filterInjectionSignals(parsed.injectionSignals),
	};
	if (Array.isArray(parsed.aliases)) {
		const aliases = parsed.aliases.filter(isJsonString);
		if (aliases.length) page.aliases = aliases;
	}
	const source =
		parsed.source === "asset"
			? "crawl"
			: jsonEnum(parsed.source, discoverySources);
	if (source) page.source = source;
	const failureKind = jsonEnum(parsed.failureKind, failureKinds);
	if (failureKind) page.failureKind = failureKind;
	if (isJsonString(parsed.error)) page.error = parsed.error;
	if (isJsonString(parsed.fetchedAt)) page.fetchedAt = parsed.fetchedAt;
	if (!page.failureKind || !page.error)
		throw new Error(`Invalid ${runFiles.manifest} in corpus`);
	return page;
}

export function verifyPageBody(
	record: CorpusPage & { outputPath: string },
	body: string,
): string {
	if (!record.outputHash || hashContent(body) !== record.outputHash) {
		throw new Error(
			`Corpus page bytes do not match ${runFiles.manifest}: ${record.outputPath}`,
		);
	}
	const markdown = markdownFromRendered(body);
	if (!record.contentHash || hashContent(markdown) !== record.contentHash) {
		throw new Error(
			`Corpus page content does not match ${runFiles.manifest}: ${record.outputPath}`,
		);
	}
	if (
		scanMarkdownForInjectionSignals(markdown).some(
			(signal) => !record.injectionSignals.includes(signal),
		)
	) {
		throw new Error(
			`Corpus page injection metadata does not match ${runFiles.manifest}: ${record.outputPath}`,
		);
	}
	return body;
}

function isSha256(value: JsonValue | undefined): value is string {
	return isJsonString(value) && /^[0-9a-f]{64}$/.test(value);
}

function isNonNegativeInteger(value: JsonValue | undefined): value is number {
	return isJsonNumber(value) && Number.isSafeInteger(value) && value >= 0;
}

function corpusListEntry(summary: RunSummary, outputDir: string) {
	return {
		output_dir: outputDir,
		seed_url: summary.seedUrl,
		generated_at: summary.generatedAt,
		status: summary.status,
		capture_mode: summary.captureMode,
		written: summary.written,
		failed: summary.failed,
		low_quality: summary.lowQuality,
		quality_warnings: summary.qualityWarnings,
		injection_signal_pages: summary.injectionSignalPages,
		seed_included: summary.seed.included,
		seed_output_path: summary.seed.outputPath,
		seed_failure_kind: summary.seed.failureKind,
		max_pages: summary.max,
		max_reached: summary.maxReached,
	};
}

function stringValue(value: JsonValue | undefined, field: string) {
	if (!isJsonString(value)) throw new Error(`Manifest record missing ${field}`);
	return value;
}
