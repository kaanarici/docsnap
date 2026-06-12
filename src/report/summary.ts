import { emptyRefreshSummary } from "../core/refresh.ts";
import type { SnapshotStats } from "../core/snapshot.ts";
import { SNAPSHOT_VERSION } from "../core/snapshot.ts";
import {
	type Config,
	discoverySources,
	type FailureKind,
	lowQualityConfidence,
	type PageRecord,
	type PageSuccess,
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
	refresh: RefreshSummary = emptyRefreshSummary(),
): RunSummary {
	let written = 0;
	let failed = 0;
	let lowQuality = 0;
	let qualityWarnings = 0;
	let hostRedirects = 0;
	const redirectedHosts = new Map<
		string,
		{ from: string; to: string; count: number }
	>();
	const bySource = emptyCounts(discoverySources);
	const byFailureKind: Partial<Record<FailureKind, number>> = {};
	const errors: RunSummary["errors"] = [];

	for (const record of records) {
		bySource[record.source]++;
		if (record.ok) {
			if (record.outputPath) written++;
			if (record.outputPath && addRedirectedHosts(record, redirectedHosts)) {
				hostRedirects++;
			}
			if (isLowQuality(record)) lowQuality++;
			if (isQualityWarning(record)) qualityWarnings++;
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
		snapshotVersion: SNAPSHOT_VERSION,
		rootHash: snapshot.rootHash,
		renderedFiles: snapshot.files,
		renderedBytes: snapshot.bytes,
		max: config.max,
		maxAppliesTo: config.maxExplicit ? "all" : "non-llms",
		maxReached: reached,
		discovered,
		deduped,
		written,
		failed,
		lowQuality,
		qualityWarnings,
		hostRedirects,
		redirectedHosts: [...redirectedHosts.values()]
			.sort((a, b) => b.count - a.count || a.from.localeCompare(b.from))
			.slice(0, 10),
		elapsedMs: Number(elapsedMs.toFixed(1)),
		pagesPerSecond: Number(
			(written / Math.max(elapsedMs / 1000, 0.001)).toFixed(2),
		),
		bySource,
		byFailureKind,
		errors,
		refresh,
	};
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

export function hasQualityWarning(record: PageSuccess): boolean {
	return record.qualityReasons.length > 0;
}

export function isQualityWarning(record: PageSuccess): boolean {
	return hasQualityWarning(record) && !isLowQuality(record);
}

function emptyCounts<T extends string>(keys: readonly T[]) {
	return Object.fromEntries(keys.map((key) => [key, 0])) as Record<T, number>;
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
