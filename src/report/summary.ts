import { cacheSummary } from "../cache/store.ts";
import { emptyRefreshSummary } from "../core/refresh.ts";
import type { SnapshotStats } from "../core/snapshot.ts";
import { snapshotSchemaVersion } from "../core/snapshot.ts";
import {
	type CacheSummary,
	type Config,
	discoverySources,
	type FailureKind,
	type InjectionSignal,
	type InlineStateSource,
	injectionSignals,
	inlineStateSources,
	lowQualityConfidence,
	type PageRecord,
	type PageSuccess,
	pageExtractors,
	type RefreshSummary,
	type RunSummary,
} from "../core/types.ts";

export function buildSummary(
	records: PageRecord[],
	config: Config,
	discovered: number,
	deduped: number,
	snapshot: SnapshotStats,
	elapsedMs: number,
	firstPageMs: number | null = null,
	refresh: RefreshSummary = emptyRefreshSummary(),
	cache: CacheSummary = emptyCacheSummary(config),
): RunSummary {
	let written = 0;
	let failed = 0;
	let lowQuality = 0;
	let qualityWarnings = 0;
	let injectionSignalPages = 0;
	let hostRedirects = 0;
	const redirectedHosts = new Map<
		string,
		{ from: string; to: string; count: number }
	>();
	const bySource = emptyCounts(discoverySources);
	const byExtractor = emptyCounts(pageExtractors);
	const byInlineStateSource: Partial<Record<InlineStateSource, number>> = {};
	const byFailureKind: Partial<Record<FailureKind, number>> = {};
	const byInjectionSignal: Partial<Record<InjectionSignal, number>> = {};
	const errors: RunSummary["errors"] = [];

	for (const record of records) {
		bySource[record.source]++;
		if (record.ok) {
			// every written-corpus count describes pages actually on disk; an ok record
			// without an outputPath (e.g. a backfilled page beyond --max) is never
			// written, so it must not inflate extractor/quality/injection counts or flip
			// run status. injection signals only matter for captured content: a failed
			// or unwritten page contributes nothing an agent can read, so its raw-HTML
			// signals must not trip --fail-on-injection-signal
			if (record.outputPath) {
				byExtractor[record.extractor]++;
				if (record.inlineStateSource) {
					byInlineStateSource[record.inlineStateSource] =
						(byInlineStateSource[record.inlineStateSource] ?? 0) + 1;
				}
				written++;
				if (addRedirectedHosts(record, redirectedHosts)) hostRedirects++;
				if (isLowQuality(record)) lowQuality++;
				if (isQualityWarning(record)) qualityWarnings++;
				if (record.injectionSignals.length) {
					injectionSignalPages++;
					for (const signal of record.injectionSignals) {
						byInjectionSignal[signal] = (byInjectionSignal[signal] ?? 0) + 1;
					}
				}
			}
			continue;
		}
		failed++;
		byFailureKind[record.failureKind] =
			(byFailureKind[record.failureKind] ?? 0) + 1;
		errors.push({
			url: record.url,
			error: record.error,
			kind: record.failureKind,
		});
	}
	const reached = maxReached(config, discovered);

	return {
		status: runStatus(written, failed, lowQuality, reached),
		seedUrl: config.seedUrl,
		outDir: config.outDir,
		dryRun: config.dryRun,
		userAgent: config.userAgent,
		...(config.ignoreRobots ? { ignoreRobots: true as const } : {}),
		generatedAt: new Date().toISOString(),
		snapshotVersion: snapshotSchemaVersion,
		rootHash: snapshot.rootHash,
		corpusFiles: snapshot.files,
		corpusBytes: snapshot.bytes,
		max: config.max,
		maxAppliesTo: config.maxExplicit ? "all" : "non-llms",
		maxReached: reached,
		discovered,
		deduped,
		written,
		failed,
		lowQuality,
		qualityWarnings,
		injectionSignalPages,
		byInjectionSignal: orderedPartialCounts(
			byInjectionSignal,
			injectionSignals,
		),
		hostRedirects,
		redirectedHosts: [...redirectedHosts.values()]
			.sort((a, b) => b.count - a.count || a.from.localeCompare(b.from))
			.slice(0, 10),
		elapsedMs: Number(elapsedMs.toFixed(1)),
		firstPageMs: firstPageMs === null ? null : Number(firstPageMs.toFixed(1)),
		pagesPerSecond: Number(
			(written / Math.max(elapsedMs / 1000, 0.001)).toFixed(2),
		),
		bySource,
		byExtractor,
		byInlineStateSource: orderedPartialCounts(
			byInlineStateSource,
			inlineStateSources,
		),
		byFailureKind,
		errors,
		refresh,
		cache,
	};
}

// Reflect the real (safe-root-validated) cache context so an unsafe configured
// DOCSNAP_CACHE_DIR reports disabled, not enabled with a bogus dir.
export function emptyCacheSummary(config: Config): CacheSummary {
	return cacheSummary(config);
}

function addRedirectedHosts(
	record: PageRecord,
	pairs: Map<string, { from: string; to: string; count: number }>,
) {
	let changed = false;
	for (const redirect of record.redirects) {
		const from = hostKey(redirect.from);
		const to = hostKey(redirect.to);
		if (!from || !to || from === to) continue;
		changed = true;
		const key = `${from}\0${to}`;
		const pair = pairs.get(key) ?? { from, to, count: 0 };
		pair.count++;
		pairs.set(key, pair);
	}
	return changed;
}

function hostKey(raw: string) {
	try {
		return new URL(raw).hostname.toLowerCase().replace(/^www\./, "");
	} catch {
		return "";
	}
}

export function isLowQuality(record: PageSuccess): boolean {
	return record.confidence < lowQualityConfidence;
}

export function isQualityWarning(record: PageSuccess): boolean {
	return record.qualityReasons.length > 0 && !isLowQuality(record);
}

function emptyCounts<T extends string>(keys: readonly T[]) {
	return Object.fromEntries(keys.map((key) => [key, 0])) as Record<T, number>;
}

function orderedPartialCounts<T extends string>(
	counts: Partial<Record<T, number>>,
	keys: readonly T[],
) {
	const out: Partial<Record<T, number>> = {};
	for (const key of keys) {
		const count = counts[key];
		if (count) out[key] = count;
	}
	return out;
}

function maxReached(config: Config, discovered: number) {
	return config.maxExplicit
		? discovered >= config.max
		: discovered === config.max;
}

function runStatus(
	written: number,
	failed: number,
	lowQuality: number,
	maxReached: boolean,
) {
	if (written === 0) return "failed";
	return failed || lowQuality || maxReached ? "partial" : "ok";
}
