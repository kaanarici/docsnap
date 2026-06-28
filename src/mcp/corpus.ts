import { realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";
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
import { resolvePriorOutputPath } from "../output/prior.ts";
import {
	assertCorpusFiles,
	corpusLimits,
	readBoundedCorpusFile,
	readOptionalCorpusFileFromRealRoot,
} from "./access.ts";
import { mcpCorpusInfo, mcpRunCounts, mcpWarnings } from "./results.ts";
import { buildRankInput, rankPages } from "./retrieval.ts";
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
	extractor?: PageExtractor;
	fetchedAt?: string;
};

type SummaryOptions = {
	includeErrors: boolean;
	includeRefreshChanges: boolean;
	errorLimit: number;
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

const globCache = new Map<string, Bun.Glob>();

export async function readSummary(outputDir: string): Promise<RunSummary> {
	const text = await readBoundedCorpusFile(
		outputDir,
		runFiles.summary,
		corpusLimits.summaryBytes,
	);
	try {
		const raw = JSON.parse(text) as Partial<RunSummary>;
		if (
			!raw ||
			typeof raw !== "object" ||
			typeof raw.seedUrl !== "string" ||
			!raw.seed ||
			typeof raw.seed !== "object" ||
			typeof raw.seed.attempted !== "boolean" ||
			typeof raw.seed.included !== "boolean" ||
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

export async function readManifest(
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
	await assertCorpusFiles(
		outputDir,
		records.flatMap((record) =>
			record.ok && record.outputPath ? [record.outputPath] : [],
		),
		corpusLimits.pageBytes,
	);
	return { summary: current, records };
}

export async function listCorpora(
	rootDir: string,
	pageSize: number,
	cursor: string | undefined,
	extraCorpora: Iterable<string>,
	options: ScanOptions = {},
) {
	const offset = decodeCursor(cursor);
	const dirs = new Set<string>(extraCorpora);
	const scanned = await scanCorpora(rootDir, maxAllSearchScannedDirs, options);
	for (const dir of scanned.dirs) dirs.add(dir);
	const corpora: ReturnType<typeof corpusListEntry>[] = [];
	let corporaSkipped = scanned.skipped;
	for (const outputDir of dirs) {
		try {
			const { summary } = await readVerifiedManifest(outputDir);
			corpora.push(corpusListEntry(summary, outputDir));
		} catch {
			corporaSkipped++;
		}
	}
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

export async function getCorpusSummary(
	outputDir: string,
	options: SummaryOptions,
) {
	const { summary } = await readVerifiedManifest(outputDir);
	const { paths, ...corpus } = mcpCorpusInfo(summary, { outputDir });
	return {
		corpus: {
			...corpus,
			generated_at: summary.generatedAt,
			paths,
		},
		status: summary.status,
		warnings: mcpWarnings(summary),
		counts: mcpRunCounts(summary, { includeMaxReached: true }),
		limits: { max_pages: summary.max, max_reached: summary.maxReached },
		failure_kinds: summary.byFailureKind,
		...(options.includeErrors
			? { errors: summary.errors.slice(0, options.errorLimit) }
			: {}),
		...(options.includeRefreshChanges
			? { refresh: cappedRefresh(summary.refresh) }
			: {}),
	};
}

export async function listPages(
	outputDir: string,
	pageSize: number,
	cursor: string | undefined,
	includeFailures: boolean,
) {
	const offset = decodeCursor(cursor);
	const records = (await readVerifiedManifest(outputDir)).records.filter(
		(record) => includeFailures || (record.ok && record.outputPath),
	);
	const pages = records.slice(offset, offset + pageSize).map((record) => ({
		...(record.outputPath ? { output_path: record.outputPath } : {}),
		url: record.url,
		final_url: record.finalUrl,
		...(record.title ? { untrusted_web_title: record.title } : {}),
		...(record.source ? { source: record.source } : {}),
		...(record.confidence !== undefined
			? { confidence: record.confidence }
			: {}),
		...(record.qualityReasons?.length
			? { quality_reasons: record.qualityReasons }
			: {}),
		...(record.failureKind ? { failure_kind: record.failureKind } : {}),
		...(record.error ? { error: record.error } : {}),
		...(record.injectionSignals.length
			? { injection_signals: record.injectionSignals }
			: {}),
	}));
	return {
		pages,
		...(offset + pageSize < records.length
			? { next_cursor: String(offset + pageSize) }
			: {}),
	};
}

export async function searchCorpus(outputDir: string, options: SearchOptions) {
	if (options.query.length > corpusLimits.searchQueryChars) {
		throw new Error(
			`query must be ${corpusLimits.searchQueryChars} characters or fewer`,
		);
	}
	const records = (
		options.records ?? (await readVerifiedManifest(outputDir)).records
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
		(record) =>
			readOptionalCorpusFileFromRealRoot(
				outputDir,
				realOutputDir,
				record.outputPath,
				corpusLimits.pageBytes,
			),
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

type ReadSliceOptions = {
	startLine: number;
	endLine?: number;
	maxChars: number;
	includeFrontmatter: boolean;
};

export async function readPageSlice(
	outputDir: string,
	outputPath: string,
	options: ReadSliceOptions,
) {
	const record = (await readVerifiedManifest(outputDir)).records.find(
		(item): item is CorpusPage & { outputPath: string } =>
			item.ok && item.outputPath === outputPath,
	);
	if (!record) throw new Error(`Output path is not in manifest: ${outputPath}`);
	if (!resolvePriorOutputPath({ outDir: outputDir }, outputPath))
		throw new Error(`Unsafe output path: ${outputPath}`);
	const body = await readBoundedCorpusFile(
		outputDir,
		outputPath,
		corpusLimits.pageBytes,
	);
	const lines = body.split(/\n/);
	let from = Math.min(options.startLine - 1, lines.length);
	let upto =
		options.endLine !== undefined
			? Math.min(Math.max(options.endLine, options.startLine), lines.length)
			: lines.length;
	if (!options.includeFrontmatter) {
		const bodyStart = lines[0] === "---" ? lines.indexOf("---", 1) + 1 : 0;
		if (bodyStart > 0) {
			from = Math.max(from, bodyStart);
			upto =
				options.endLine !== undefined && options.endLine <= bodyStart
					? Math.min(
							lines.length,
							from + options.endLine - options.startLine + 1,
						)
					: Math.max(upto, from);
		}
	}
	const selected = lines.slice(from, upto).join("\n");
	const truncated = selected.length > options.maxChars;
	const text = truncated ? selected.slice(0, options.maxChars) : selected;
	const lineCount = text ? text.split(/\n/).length : 1;
	return {
		record,
		startLine: from + 1,
		endLine: from + lineCount,
		truncated,
		text,
	};
}

export function decodeCursor(cursor: string | undefined): number {
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
			page.contentHash &&
			page.extractor &&
			page.confidence !== undefined
		: page.failureKind && page.error;
	if (!valid) {
		throw new Error(`Invalid ${runFiles.manifest} in corpus`);
	}
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

function cappedRefresh(summary: RunSummary["refresh"]) {
	return {
		...summary,
		changedPages: summary.changedPages.slice(
			0,
			corpusLimits.refreshChangedPages,
		),
		changedPagesTruncated:
			summary.changedPages.length > corpusLimits.refreshChangedPages,
	};
}
