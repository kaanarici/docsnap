import { readdir } from "node:fs/promises";
import { isAbsolute, join, parse, relative, resolve } from "node:path";
import { isInsideOrSame, isWindowsAbsolute } from "../core/fs-safety.ts";
import {
	type FailureKind,
	filterInjectionSignals,
	type InjectionSignal,
	type RunSummary,
} from "../core/types.ts";
import { runFiles } from "../output/files.ts";
import { resolvePriorOutputPath } from "../output/prior.ts";
import {
	corpusLimits,
	logDiagnostic,
	McpReadLimitError,
	readBoundedCorpusFile,
} from "./access.ts";
import { globMatches } from "./glob.ts";
import { buildRankInput, type RankedSnippet, rankPages } from "./retrieval.ts";

export type CorpusPage = {
	ok: boolean;
	url: string;
	finalUrl: string;
	injectionSignals: InjectionSignal[];
	outputPath?: string;
	title?: string;
	source?: string;
	confidence?: number;
	qualityReasons?: string[];
	failureKind?: FailureKind;
	error?: string;
	contentHash?: string;
	extractor?: string;
};

export type PageRead = {
	record: CorpusPage & { outputPath: string };
	startLine: number;
	endLine: number;
	truncated: boolean;
	text: string;
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
};

export type RankedSearch = {
	matches: RankedSnippet[];
	truncated: boolean;
};

type DirectoryEntry = {
	name: string;
	isDirectory(): boolean;
};

type ManifestJson = {
	ok?: unknown;
	url?: unknown;
	finalUrl?: unknown;
	outputPath?: unknown;
	title?: unknown;
	source?: unknown;
	confidence?: unknown;
	qualityReasons?: unknown;
	failureKind?: unknown;
	error?: unknown;
	injectionSignals?: unknown;
	contentHash?: unknown;
	extractor?: unknown;
};

const maxScannedDirs = 1000;

export async function readSummary(outputDir: string): Promise<RunSummary> {
	const text = await readCorpusFile(
		outputDir,
		runFiles.summary,
		corpusLimits.summaryBytes,
	);
	try {
		const raw = JSON.parse(text) as LooseSummary;
		if (!raw || typeof raw !== "object" || !raw.seedUrl) {
			throw new Error("missing seedUrl");
		}
		// a parseable but partially-written/foreign summary may omit collection
		// fields; default them so read tools degrade gracefully instead of throwing
		return {
			...raw,
			errors: raw.errors ?? [],
			byFailureKind: raw.byFailureKind ?? {},
			refresh: raw.refresh
				? { ...raw.refresh, changedPages: raw.refresh.changedPages ?? [] }
				: raw.refresh,
		} as RunSummary;
	} catch {
		throw new Error(`Invalid ${runFiles.summary} in corpus`);
	}
}

type LooseSummary = Omit<RunSummary, "errors" | "byFailureKind" | "refresh"> &
	Partial<Pick<RunSummary, "errors" | "byFailureKind" | "refresh">>;

export async function readManifest(outputDir: string): Promise<CorpusPage[]> {
	const text = await readCorpusFile(
		outputDir,
		runFiles.manifest,
		corpusLimits.manifestBytes,
	);
	const records: CorpusPage[] = [];
	for (const line of text.split(/\n/)) {
		if (!line.trim()) continue;
		records.push(parseManifestLine(line));
	}
	return records;
}

export async function readCorpusFile(
	outputDir: string,
	path: string,
	maxBytes = corpusLimits.resourceBytes,
): Promise<string> {
	return await readBoundedCorpusFile(outputDir, path, maxBytes);
}

export async function listCorpora(
	rootDir: string,
	pageSize: number,
	cursor: string | undefined,
	extraCorpora: Iterable<string>,
) {
	const offset = decodeCursor(cursor);
	const dirs = new Set<string>(extraCorpora);
	for (const dir of await scanCorpora(rootDir)) dirs.add(dir);
	const sorted = [...dirs].sort((a, b) => a.localeCompare(b));
	const selected = sorted.slice(offset, offset + pageSize);
	const corpora = [];
	for (const outputDir of selected) {
		try {
			corpora.push(corpusListEntry(await readSummary(outputDir), outputDir));
		} catch {}
	}
	return {
		corpora,
		...(offset + pageSize < sorted.length
			? { next_cursor: String(offset + pageSize) }
			: {}),
	};
}

export async function getCorpusSummary(
	outputDir: string,
	options: SummaryOptions,
) {
	const summary = await readSummary(outputDir);
	return {
		corpus: {
			output_dir: outputDir,
			seed_url: summary.seedUrl,
			generated_at: summary.generatedAt,
			paths: corpusPaths(outputDir),
		},
		status: summary.status,
		counts: {
			written: summary.written,
			failed: summary.failed,
			low_quality: summary.lowQuality,
			quality_warnings: summary.qualityWarnings,
			injection_signal_pages: summary.injectionSignalPages,
			discovered: summary.discovered,
			deduped: summary.deduped,
			max_reached: summary.maxReached,
		},
		failure_kinds: summary.byFailureKind,
		...(options.includeErrors
			? { errors: summary.errors.slice(0, options.errorLimit) }
			: {}),
		...(options.includeRefreshChanges && summary.refresh
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
	const records = (await readManifest(outputDir)).filter(
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
		...(record.injectionSignals.length
			? { injectionSignals: record.injectionSignals }
			: {}),
	}));
	return {
		pages,
		...(offset + pageSize < records.length
			? { next_cursor: String(offset + pageSize) }
			: {}),
	};
}

export async function searchCorpus(
	outputDir: string,
	options: SearchOptions,
): Promise<RankedSearch> {
	if (options.query.length > corpusLimits.searchQueryChars) {
		throw new Error(
			`query must be ${corpusLimits.searchQueryChars} characters or fewer`,
		);
	}
	const records = (await readManifest(outputDir)).filter(
		(record) =>
			record.ok &&
			record.outputPath &&
			(!options.pathGlob || globMatches(options.pathGlob, record.outputPath)),
	);
	const { input, truncated } = await buildRankInput(
		records,
		(record) => loadCorpusBody(outputDir, record.outputPath),
		{ maxPages: corpusLimits.searchPages, maxBytes: corpusLimits.searchBytes },
	);
	const matches = rankPages(input, options.query, {
		maxResults: options.maxResults,
		snippetChars: options.snippetChars,
		excludeInjection: options.excludeInjection === true,
	});
	return { matches, truncated };
}

// returns null on a per-page read-cap breach so retrieval can record the skip
// without aborting the whole ranking pass
async function loadCorpusBody(
	outputDir: string,
	outputPath: string,
): Promise<string | null> {
	try {
		return await readCorpusOutput(outputDir, outputPath);
	} catch (error) {
		if (error instanceof McpReadLimitError) return null;
		throw error;
	}
}

export type ReadSliceOptions = {
	startLine: number;
	endLine?: number;
	maxChars: number;
	includeFrontmatter: boolean;
};

export async function readPageSlice(
	outputDir: string,
	outputPath: string,
	options: ReadSliceOptions,
): Promise<PageRead> {
	const record = (await readManifest(outputDir)).find(
		(item): item is CorpusPage & { outputPath: string } =>
			item.ok && item.outputPath === outputPath,
	);
	if (!record) {
		throw new Error(`Output path is not in manifest: ${outputPath}`);
	}
	if (!resolvePriorOutputPath({ outDir: outputDir }, outputPath)) {
		throw new Error(`Unsafe output path: ${outputPath}`);
	}
	const source = options.includeFrontmatter
		? await readCorpusOutput(outputDir, outputPath)
		: stripFrontmatter(await readCorpusOutput(outputDir, outputPath));
	const lines = source.split(/\n/);
	const from = Math.min(options.startLine - 1, lines.length);
	// optional end_line caps the slice to an exact line span before the char cap
	const upto =
		options.endLine !== undefined
			? Math.min(Math.max(options.endLine, options.startLine), lines.length)
			: lines.length;
	const selected = lines.slice(from, upto).join("\n");
	const truncated = selected.length > options.maxChars;
	const text = truncated ? selected.slice(0, options.maxChars) : selected;
	const lineCount = text ? text.split(/\n/).length : 1;
	return {
		record,
		startLine: options.startLine,
		endLine: options.startLine + lineCount - 1,
		truncated,
		text,
	};
}

export function decodeCursor(cursor: string | undefined): number {
	if (cursor === undefined) return 0;
	if (!/^\d{1,8}$/.test(cursor)) throw new Error("Invalid cursor");
	return Number(cursor);
}

export function assertSafeProjectRoot(rootDir: string): void {
	if (!rootDir || isAbsolute(rootDir) || isWindowsAbsolute(rootDir)) {
		throw new Error("root_dir must be a relative directory under cwd");
	}
	if (rootDir.split(/[\\/]+/).includes("..")) {
		throw new Error("root_dir must not contain '..'");
	}
	const cwd = resolve(process.cwd());
	const target = resolve(cwd, rootDir);
	if (!isInsideOrSame(cwd, target)) {
		throw new Error("root_dir must stay under cwd");
	}
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
	if (typeof raw.outputPath === "string") page.outputPath = raw.outputPath;
	if (typeof raw.title === "string") page.title = raw.title;
	if (typeof raw.source === "string") page.source = raw.source;
	if (typeof raw.confidence === "number") page.confidence = raw.confidence;
	if (Array.isArray(raw.qualityReasons)) {
		page.qualityReasons = raw.qualityReasons.filter(
			(item): item is string => typeof item === "string",
		);
	}
	if (typeof raw.failureKind === "string") {
		page.failureKind = raw.failureKind as FailureKind;
	}
	if (typeof raw.error === "string") page.error = raw.error;
	if (typeof raw.contentHash === "string") page.contentHash = raw.contentHash;
	if (typeof raw.extractor === "string") page.extractor = raw.extractor;
	return page;
}

async function scanCorpora(rootDir: string): Promise<string[]> {
	assertSafeProjectRoot(rootDir);
	const root = resolve(process.cwd(), rootDir);
	const found: string[] = [];
	let visited = 0;
	async function walk(dir: string): Promise<void> {
		if (visited++ > maxScannedDirs) return;
		let entries: DirectoryEntry[];
		try {
			entries = await readdir(dir, { withFileTypes: true });
		} catch (error) {
			if (
				error instanceof Error &&
				"code" in error &&
				error.code === "ENOENT"
			) {
				return;
			}
			logDiagnostic(error);
			throw new Error("Unable to scan corpus directories under root_dir");
		}
		const names = new Set(entries.map((entry) => entry.name));
		if (names.has(runFiles.summary) && names.has(runFiles.manifest)) {
			found.push(displayPath(dir));
			return;
		}
		for (const entry of entries) {
			if (entry.isDirectory()) await walk(join(dir, entry.name));
		}
	}
	await walk(root);
	return found;
}

function corpusListEntry(summary: RunSummary, outputDir: string) {
	return {
		output_dir: outputDir,
		seed_url: summary.seedUrl,
		generated_at: summary.generatedAt,
		status: summary.status,
		written: summary.written,
		failed: summary.failed,
		low_quality: summary.lowQuality,
		max_reached: summary.maxReached,
	};
}

function corpusPaths(outputDir: string) {
	return {
		summary: `${outputDir}/${runFiles.summary}`,
		manifest: `${outputDir}/${runFiles.manifest}`,
		tree: `${outputDir}/${runFiles.tree}`,
		agent_readme: `${outputDir}/${runFiles.agentReadme}`,
	};
}

async function readCorpusOutput(
	outputDir: string,
	outputPath: string,
): Promise<string> {
	return await readBoundedCorpusFile(
		outputDir,
		outputPath,
		corpusLimits.pageBytes,
	);
}

function displayPath(path: string) {
	const rel = relative(process.cwd(), path);
	return rel && !rel.startsWith("..") && !parse(rel).root ? rel : path;
}

function stringValue(value: unknown, field: string) {
	if (typeof value !== "string")
		throw new Error(`Manifest record missing ${field}`);
	return value;
}

function stripFrontmatter(text: string) {
	if (!text.startsWith("---\n")) return text;
	const end = text.indexOf("\n---\n", 4);
	return end >= 0 ? text.slice(end + 5) : text;
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
