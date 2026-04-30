import type { SnapshotStats } from "../core/snapshot.ts";
import { SNAPSHOT_VERSION } from "../core/snapshot.ts";
import {
	type Config,
	discoverySources,
	type FailureKind,
	lowQualityConfidence,
	type PageRecord,
	type RunSummary,
} from "../core/types.ts";

export function buildSummary(
	records: PageRecord[],
	config: Config,
	discovered: number,
	deduped: number,
	snapshot: SnapshotStats,
	elapsedMs: number,
): RunSummary {
	let written = 0;
	let failed = 0;
	let lowQuality = 0;
	const bySource = emptyCounts(discoverySources);
	const byFailureKind: Partial<Record<FailureKind, number>> = {};
	const errors: RunSummary["errors"] = [];

	for (const record of records) {
		bySource[record.source]++;
		if (record.ok) {
			if (record.outputPath) written++;
			if (record.confidence < lowQualityConfidence) lowQuality++;
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
		elapsedMs: Number(elapsedMs.toFixed(1)),
		pagesPerSecond: Number(
			(written / Math.max(elapsedMs / 1000, 0.001)).toFixed(2),
		),
		bySource,
		byFailureKind,
		errors,
	};
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
