import { realpath, stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { defaultUserAgent } from "../core/config.ts";
import { runBounded } from "../core/parallel.ts";
import { emptyRefreshSummary } from "../core/refresh.ts";
import {
	hashContent,
	snapshotSchemaVersion,
	snapshotStats,
} from "../core/snapshot.ts";
import {
	type DiscoverySource,
	discoverySources,
	type FailureKind,
	failureKinds,
	filterInjectionSignals,
	type InjectionSignal,
	type PageExtractor,
	pageExtractors,
	type RunSummary,
} from "../core/types.ts";
import { runFiles } from "../output/files.ts";
import {
	markdownFromRendered,
	resolvePriorOutputPath,
} from "../output/prior.ts";
import { buildRankInput, rankPages } from "../search/rank.ts";
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
	genericWhenNoContentTerms?: boolean;
	preferredOutputPaths?: readonly string[];
	records?: CorpusPage[];
};

type ManifestJson = Partial<Record<keyof CorpusPage, unknown>>;
type VerifiedManifest = { summary: RunSummary; records: CorpusPage[] };

const globCache = new Map<string, Bun.Glob>();
const manifestCache = new Map<
	string,
	{ stamp: string; value: VerifiedManifest }
>();
const manifestCacheMax = 16;

export async function readSummary(outputDir: string): Promise<RunSummary> {
	const text = await readBoundedCorpusFile(
		outputDir,
		runFiles.summary,
		corpusLimits.summaryBytes,
	);
	try {
		const parsed = JSON.parse(text) as unknown;
		const raw = legacySummary(parsed) ?? (parsed as Partial<RunSummary>);
		if (
			!raw ||
			typeof raw !== "object" ||
			typeof raw.seedUrl !== "string" ||
			!raw.seed ||
			typeof raw.seed !== "object" ||
			typeof raw.seed.attempted !== "boolean" ||
			typeof raw.seed.included !== "boolean" ||
			raw.snapshotVersion !== snapshotSchemaVersion ||
			!isSha256(raw.rootHash) ||
			!isNonNegativeInteger(raw.corpusFiles) ||
			!isNonNegativeInteger(raw.corpusBytes) ||
			!Array.isArray(raw.warnings) ||
			(raw.captureMode !== "page" && raw.captureMode !== "site") ||
			!Array.isArray(raw.errors) ||
			!raw.byFailureKind ||
			typeof raw.byFailureKind !== "object" ||
			!raw.refresh ||
			typeof raw.refresh !== "object" ||
			!Array.isArray(raw.refresh.changedPages)
		) {
			throw new Error("invalid summary shape");
		}
		return raw as RunSummary;
	} catch {
		throw new Error(`Invalid ${runFiles.summary} in corpus`);
	}
}

function legacySummary(value: unknown): Partial<RunSummary> | undefined {
	if (!value || typeof value !== "object" || "seed" in value) return undefined;
	const raw = value as Partial<RunSummary> & {
		renderedFiles?: unknown;
		renderedBytes?: unknown;
	};
	if (
		raw.snapshotVersion !== snapshotSchemaVersion ||
		!isSha256(raw.rootHash) ||
		!isNonNegativeInteger(raw.renderedFiles) ||
		!isNonNegativeInteger(raw.renderedBytes) ||
		typeof raw.seedUrl !== "string" ||
		typeof raw.written !== "number"
	) {
		return undefined;
	}
	const seedFailure = Array.isArray(raw.errors)
		? raw.errors.find((error) => error?.url === raw.seedUrl)
		: undefined;
	return {
		...raw,
		seed: {
			attempted: true,
			included: raw.written > 0 && !seedFailure,
			url: raw.seedUrl,
			...(seedFailure
				? {
						omissionReason: "failed" as const,
						failureKind: seedFailure.kind,
						error: seedFailure.error,
					}
				: {}),
		},
		warnings: [],
		captureMode: "site",
		userAgent: defaultUserAgent,
		corpusFiles: raw.renderedFiles,
		corpusBytes: raw.renderedBytes,
		injectionSignalPages: 0,
		byInjectionSignal: {},
		byExtractor: Object.fromEntries(
			pageExtractors.map((extractor) => [extractor, 0]),
		) as RunSummary["byExtractor"],
		byInlineStateSource: {},
		firstPageMs: null,
		refresh: emptyRefreshSummary(),
		cache: {
			enabled: false,
			dir: null,
			hits: 0,
			misses: 0,
			stale: 0,
			revalidated: 0,
			written: 0,
			notStored: 0,
			bytesRead: 0,
			bytesWritten: 0,
			evictedBytes: 0,
		},
	};
}

async function readManifest(
	outputDir: string,
	options: { summaryAlreadyRead?: boolean } = {},
): Promise<CorpusPage[]> {
	if (!options.summaryAlreadyRead) await readSummary(outputDir);
	const text = await readBoundedCorpusFile(
		outputDir,
		runFiles.manifest,
		corpusLimits.manifestBytes,
	);
	const records = text
		.split(/\n/)
		.filter((line) => line.trim())
		.map(parseManifestLine);
	for (const record of records) {
		if (
			record.outputPath &&
			!resolvePriorOutputPath({ outDir: outputDir }, record.outputPath)
		) {
			throw new Error(`Invalid ${runFiles.manifest} in corpus`);
		}
	}
	return records;
}

export async function readVerifiedManifest(
	outputDir: string,
	summary?: RunSummary,
): Promise<{ summary: RunSummary; records: CorpusPage[] }> {
	const current = summary ?? (await readSummary(outputDir));
	const records = await readManifest(outputDir, { summaryAlreadyRead: true });
	if (!manifestMatchesSummary(current, records)) {
		throw new Error(`Invalid ${runFiles.manifest} in corpus`);
	}
	const retained = records.filter(
		(record): record is CorpusPage & { outputPath: string } =>
			record.ok && Boolean(record.outputPath),
	);
	const realOutputDir = await realpath(outputDir);
	const files = await runBounded(
		retained,
		{ concurrency: 8, perOrigin: 8, key: () => "" },
		async (record) => ({
			path: record.outputPath,
			body: verifyPageBody(
				record,
				await readBoundedCorpusFileFromRealRoot(
					outputDir,
					realOutputDir,
					record.outputPath,
					corpusLimits.pageBytes,
				),
			),
		}),
	);
	const snapshot = snapshotStats(files);
	if (
		snapshot.rootHash !== current.rootHash ||
		snapshot.files !== current.corpusFiles ||
		snapshot.bytes !== current.corpusBytes
	) {
		throw new Error(`Invalid ${runFiles.summary} in corpus`);
	}
	return { summary: current, records };
}

async function manifestStamp(
	outputDir: string,
	records: CorpusPage[] = [],
): Promise<string> {
	const paths = [
		runFiles.summary,
		runFiles.manifest,
		...records.flatMap((record) =>
			record.ok && record.outputPath ? [record.outputPath] : [],
		),
	];
	const infos = await Promise.all(
		paths.map(async (path) => ({
			path,
			info: await stat(join(outputDir, path)),
		})),
	);
	return infos
		.map(
			({ path, info }) =>
				`${path}:${info.dev}:${info.ino}:${info.ctimeMs}:${info.mtimeMs}:${info.size}`,
		)
		.join("|");
}

async function cachedVerifiedManifest(
	outputDir: string,
): Promise<VerifiedManifest> {
	const hit = manifestCache.get(outputDir);
	let stamp: string | undefined;
	try {
		stamp = await manifestStamp(outputDir, hit?.value.records);
	} catch {
		// A refresh can replace the manifest and remove pages from the cached one.
	}
	if (hit && hit.stamp === stamp) return hit.value;
	const value = await readVerifiedManifest(outputDir);
	if (manifestCache.size >= manifestCacheMax) {
		const oldest = manifestCache.keys().next().value;
		if (oldest !== undefined) manifestCache.delete(oldest);
	}
	manifestCache.set(outputDir, {
		stamp: await manifestStamp(outputDir, value.records),
		value,
	});
	return value;
}

export async function listCorpora(
	rootDir: string,
	pageSize: number,
	cursor: string | undefined,
	options: ScanOptions = {},
) {
	const offset = decodeCursor(cursor);
	const scanned = await scanCorpora(rootDir, maxAllSearchScannedDirs, options);
	const dirList = scanned.dirs;
	const entries = await runBounded(
		dirList,
		{ concurrency: 8, perOrigin: 1, key: (dir) => dir },
		async (outputDir) => {
			try {
				const { summary } = await cachedVerifiedManifest(outputDir);
				return corpusListEntry(summary, outputDir);
			} catch {
				return undefined;
			}
		},
	);
	const corpora = entries.filter(
		(entry): entry is ReturnType<typeof corpusListEntry> => entry !== undefined,
	);
	const corporaSkipped = scanned.skipped + (dirList.length - corpora.length);
	corpora.sort(
		(left, right) =>
			right.generated_at.localeCompare(left.generated_at) ||
			left.output_dir.localeCompare(right.output_dir),
	);
	const page = corpora.slice(offset, offset + pageSize);
	return {
		corpora: page,
		truncated: scanned.truncated,
		corporaSkipped,
		...(offset + pageSize < corpora.length
			? { next_cursor: String(offset + pageSize) }
			: {}),
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
	if (options.query.length > corpusLimits.searchQueryChars) {
		throw new Error(
			`query must be ${corpusLimits.searchQueryChars} characters or fewer`,
		);
	}
	const records = (
		options.records ?? (await cachedVerifiedManifest(outputDir)).records
	).filter(
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
		{
			query: options.query,
			genericWhenNoContentTerms: options.genericWhenNoContentTerms === true,
		},
	);
	const ranked = rankPages(input, options.query, {
		maxResults: options.maxResults + 1,
		snippetChars: options.snippetChars,
		excludeInjection: options.excludeInjection === true,
		genericWhenNoContentTerms: options.genericWhenNoContentTerms === true,
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
	const written = records.filter(
		(record) => record.ok && record.outputPath,
	).length;
	const failed = records.filter((record) => !record.ok).length;
	if (written !== summary.written || failed !== summary.failed) return false;
	if (!summary.seed.included) return true;
	if (summary.seed.outputPath) {
		return records.some(
			(record) => record.ok && record.outputPath === summary.seed.outputPath,
		);
	}
	if (summary.seed.kind === "discovery_resource" && summary.seed.source) {
		return records.some(
			(record) =>
				record.ok &&
				Boolean(record.outputPath) &&
				record.source === summary.seed.source,
		);
	}
	return written > 0;
}

export function globMatches(pattern: string, path: string): boolean {
	if (!globCache.has(pattern)) globCache.set(pattern, new Bun.Glob(pattern));
	return globCache.get(pattern)!.match(path);
}

function decodeCursor(cursor: string | undefined): number {
	if (cursor === undefined) return 0;
	if (!/^\d{1,8}$/.test(cursor)) throw new Error("Invalid cursor");
	return Number(cursor);
}

function parseManifestLine(line: string): CorpusPage {
	let raw: ManifestJson;
	try {
		raw = JSON.parse(line) as ManifestJson;
	} catch {
		throw new Error(`Invalid ${runFiles.manifest} in corpus`);
	}
	const page: CorpusPage = {
		ok: raw.ok === true,
		url: stringValue(raw.url, "url"),
		finalUrl: stringValue(raw.finalUrl, "finalUrl"),
		injectionSignals: filterInjectionSignals(raw.injectionSignals),
	};
	if (Array.isArray(raw.aliases)) {
		const aliases = raw.aliases.filter(
			(item): item is string => typeof item === "string",
		);
		if (aliases.length) page.aliases = aliases;
	}
	if (typeof raw.outputPath === "string") page.outputPath = raw.outputPath;
	if (typeof raw.title === "string") page.title = raw.title;
	const source = enumValue(raw.source, discoverySources);
	if (source) page.source = source;
	if (typeof raw.confidence === "number" && Number.isFinite(raw.confidence)) {
		page.confidence = raw.confidence;
	}
	if (Array.isArray(raw.qualityReasons)) {
		page.qualityReasons = raw.qualityReasons.filter(
			(item): item is string => typeof item === "string",
		);
	}
	const failureKind = enumValue(raw.failureKind, failureKinds);
	if (failureKind) page.failureKind = failureKind;
	if (typeof raw.error === "string") page.error = raw.error;
	if (typeof raw.contentHash === "string") page.contentHash = raw.contentHash;
	if (typeof raw.outputHash === "string") page.outputHash = raw.outputHash;
	const extractor = enumValue(raw.extractor, pageExtractors);
	if (extractor) page.extractor = extractor;
	if (typeof raw.fetchedAt === "string") page.fetchedAt = raw.fetchedAt;
	validateManifestPage(page);
	return page;
}

function validateManifestPage(page: CorpusPage): void {
	const valid = page.ok
		? page.outputPath &&
			page.source &&
			isSha256(page.contentHash) &&
			isSha256(page.outputHash) &&
			page.extractor &&
			page.confidence !== undefined
		: page.failureKind && page.error;
	if (!valid) {
		throw new Error(`Invalid ${runFiles.manifest} in corpus`);
	}
}

function verifyPageBody(
	record: CorpusPage & { outputPath: string },
	body: string,
): string {
	if (!record.outputHash || hashContent(body) !== record.outputHash) {
		throw new Error(
			`Corpus page bytes do not match ${runFiles.manifest}: ${record.outputPath}`,
		);
	}
	if (
		!record.contentHash ||
		hashContent(markdownFromRendered(body)) !== record.contentHash
	) {
		throw new Error(
			`Corpus page content does not match ${runFiles.manifest}: ${record.outputPath}`,
		);
	}
	return body;
}

function isSha256(value: string | undefined): value is string {
	return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function isNonNegativeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
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

function stringValue(value: unknown, field: string) {
	if (typeof value !== "string")
		throw new Error(`Manifest record missing ${field}`);
	return value;
}

function enumValue<T extends string>(
	value: unknown,
	allowed: readonly T[],
): T | undefined {
	return typeof value === "string" && allowed.includes(value as T)
		? (value as T)
		: undefined;
}
