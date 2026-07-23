import { cacheSummary } from "../cache/store.ts";
import { captureSelectionHash } from "../core/config.ts";
import { emptyRefreshSummary } from "../core/refresh.ts";
import type { SnapshotStats } from "../core/snapshot.ts";
import { snapshotSchemaVersion } from "../core/snapshot.ts";
import {
	type DiscoveredUrl,
	type DiscoveryResourceSeed,
	discoverySources,
	type FailureKind,
	type InjectionSignal,
	type InlineStateSource,
	injectionSignals,
	inlineStateSources,
	lowQualityConfidence,
	type PageOutput,
	type PageRecord,
	type PageSuccess,
	type PipelineConfig,
	pageExtractors,
	type RefreshSummary,
	type RunSummary,
	type RunWarning,
	type SeedSummary,
} from "../core/types.ts";
import { classifyDiscoveryResource } from "../core/url.ts";

export function buildSummary(
	records: PageRecord[],
	outputs: PageOutput[],
	config: PipelineConfig,
	attempted: DiscoveredUrl[],
	deduped: number,
	snapshot: SnapshotStats,
	elapsedMs: number,
	firstPageMs: number | null = null,
	refresh: RefreshSummary = emptyRefreshSummary(),
	cache = cacheSummary(config),
	seedResource?: DiscoveryResourceSeed,
	assetRecoveryTruncated = false,
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
		if (record.ok) continue;
		failed++;
		byFailureKind[record.failureKind] =
			(byFailureKind[record.failureKind] ?? 0) + 1;
		errors.push({
			url: record.url,
			error: record.error,
			kind: record.failureKind,
		});
	}

	for (const record of outputs) {
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
	const reached = maxReached(config, attempted);
	const selectionHash = captureSelectionHash(config.topic);
	const seed = seedSummary(records, outputs, config, seedResource);
	const warnings = runWarnings(seed);
	if (assetRecoveryTruncated) {
		warnings.push({
			kind: "asset_recovery_truncated",
			message: "JS asset recovery stopped at its safety budget.",
		});
	}

	return {
		status: runStatus(
			written,
			failed,
			lowQuality,
			reached || assetRecoveryTruncated,
		),
		seedUrl: config.seedUrl,
		seed,
		warnings,
		outDir: config.outDir,
		dryRun: config.dryRun,
		captureMode: config.pageOnly ? "page" : "site",
		userAgent: config.userAgent,
		generatedAt: new Date().toISOString(),
		snapshotVersion: snapshotSchemaVersion,
		rootHash: snapshot.rootHash,
		corpusFiles: snapshot.files,
		corpusBytes: snapshot.bytes,
		max: config.max,
		maxAppliesTo: config.maxExplicit ? "all" : "non-llms",
		maxReached: reached,
		...(selectionHash ? { selectionHash } : {}),
		discovered: attempted.length,
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

function runWarnings(seed: SeedSummary): RunWarning[] {
	const resource = seed.kind === "discovery_resource";
	if (!seed.included) {
		return [
			{
				kind: resource ? "discovery_resource_empty" : "seed_omitted",
				message: resource
					? "The requested discovery resource produced no captured pages."
					: "The requested seed page is not in the written corpus.",
				...(seed.omissionReason ? { omissionReason: seed.omissionReason } : {}),
				...(seed.failureKind ? { failureKind: seed.failureKind } : {}),
				...(seed.error ? { error: seed.error } : {}),
			},
		];
	}
	if (resource) {
		return [
			{
				kind: "discovery_resource_seed",
				message:
					"The requested seed was used as a discovery resource, not captured as an exact page.",
				...(seed.source ? { source: seed.source } : {}),
				pagesWritten: seed.pagesWritten ?? 0,
			},
		];
	}
	if (seed.redirected) {
		return [
			{
				kind: "seed_redirected",
				message: "The requested seed redirected before capture.",
				...(seed.url ? { url: seed.url } : {}),
				...(seed.finalUrl ? { finalUrl: seed.finalUrl } : {}),
			},
		];
	}
	return [];
}

function seedSummary(
	records: PageRecord[],
	outputs: PageOutput[],
	config: PipelineConfig,
	seedResource: DiscoveryResourceSeed | undefined,
): SeedSummary {
	const resource = classifyDiscoveryResource(config.seedUrl);
	const includedResource =
		resource && includedDiscoveryResourceSeed(outputs, resource, seedResource);
	if (includedResource) return includedResource;
	const output = outputs.find((record) => record.wasSeed);
	if (output) {
		const url = config.seedUrl;
		return {
			attempted: true,
			included: true,
			...seedLocation(url, output.finalUrl, output.redirects.length > 0),
			outputPath: output.outputPath,
			source: output.source,
		};
	}
	const attempted = records.find((record) => record.wasSeed);
	const resourceKind = resource ? { kind: "discovery_resource" as const } : {};
	if (!attempted) {
		return resource
			? {
					attempted: true,
					included: false,
					kind: "discovery_resource",
					url: resource.url,
					finalUrl: resource.url,
					source: resource.source,
					omissionReason: "empty_resource",
				}
			: {
					attempted: false,
					included: false,
					omissionReason: "not_discovered",
				};
	}
	if (!attempted.ok) {
		return {
			attempted: true,
			included: false,
			...seedLocation(
				attempted.url,
				attempted.finalUrl,
				attempted.redirects.length > 0,
			),
			...resourceKind,
			source: attempted.source,
			omissionReason: "failed",
			failureKind: attempted.failureKind,
			error: attempted.error,
		};
	}
	return {
		attempted: true,
		included: false,
		...seedLocation(
			attempted.url,
			attempted.finalUrl,
			attempted.redirects.length > 0,
		),
		...resourceKind,
		source: attempted.source,
		omissionReason: "not_written",
	};
}

function seedLocation(
	url: string,
	finalUrl: string,
	redirected = url !== finalUrl,
) {
	return {
		url,
		finalUrl,
		...(redirected ? { redirected: true as const } : {}),
	};
}

function includedDiscoveryResourceSeed(
	outputs: PageOutput[],
	resource: Pick<DiscoveryResourceSeed, "url" | "source">,
	seedResource: DiscoveryResourceSeed | undefined,
): SeedSummary | undefined {
	const seed =
		seedResource?.source === resource.source
			? seedResource
			: {
					url: resource.url,
					finalUrl: resource.url,
					source: resource.source,
				};
	const pagesWritten = outputs.filter(
		(record) => record.source === resource.source,
	).length;
	if (pagesWritten === 0) return undefined;
	return {
		attempted: true,
		included: true,
		kind: "discovery_resource",
		...seedLocation(seed.url, seed.finalUrl),
		source: resource.source,
		pagesWritten,
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

function maxReached(config: PipelineConfig, attempted: DiscoveredUrl[]) {
	if (config.pageOnly) return false;
	return config.maxExplicit
		? attempted.length >= config.max
		: attempted.filter((item) => item.source !== "llms").length >= config.max;
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
