import { cacheSummary } from "../cache/store.ts";
import { captureSelectionHash } from "../core/config.ts";
import { emptyRefreshSummary } from "../core/refresh.ts";
import { type SnapshotStats, snapshotSchemaVersion } from "../core/snapshot.ts";
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
	discoveryTruncated = false,
	render?: RunSummary["render"],
): RunSummary {
	const written = outputs.length;
	let failed = 0;
	let maxEligible = 0;
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
			if (config.maxExplicit || record.source !== "llms") maxEligible++;
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

	for (const record of outputs) {
		byExtractor[record.extractor]++;
		if (record.inlineStateSource) {
			byInlineStateSource[record.inlineStateSource] =
				(byInlineStateSource[record.inlineStateSource] ?? 0) + 1;
		}
		if (addRedirectedHosts(record, redirectedHosts)) hostRedirects++;
		if (record.confidence < lowQualityConfidence) lowQuality++;
		if (
			record.qualityReasons.length &&
			record.confidence >= lowQualityConfidence
		)
			qualityWarnings++;
		if (record.injectionSignals.length) {
			injectionSignalPages++;
			for (const signal of record.injectionSignals) {
				byInjectionSignal[signal] = (byInjectionSignal[signal] ?? 0) + 1;
			}
		}
	}
	const reached = !config.pageOnly && maxEligible >= config.max;
	const selectionHash = captureSelectionHash(config.topic);
	const seed = seedSummary(records, outputs, config, seedResource);
	const warnings = runWarnings(seed);
	const partial =
		failed || lowQuality || reached || discoveryTruncated || render?.truncated;

	const summary: RunSummary = {
		status: written === 0 ? "failed" : partial ? "partial" : "ok",
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
		discoveryTruncated,
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
	if (selectionHash) summary.selectionHash = selectionHash;
	if (render) summary.render = render;
	return summary;
}

function runWarnings(seed: SeedSummary): RunWarning[] {
	const resource = seed.kind === "discovery_resource";
	if (!seed.included) {
		const warning: Extract<
			RunWarning,
			{ kind: "seed_omitted" | "discovery_resource_empty" }
		> = {
			kind: resource ? "discovery_resource_empty" : "seed_omitted",
			message: resource
				? "The requested discovery resource produced no captured pages."
				: "The requested seed page is not in the written corpus.",
		};
		if (seed.omissionReason) warning.omissionReason = seed.omissionReason;
		if (seed.failureKind) warning.failureKind = seed.failureKind;
		if (seed.error) warning.error = seed.error;
		return [warning];
	}
	if (resource) {
		const warning: Extract<RunWarning, { kind: "discovery_resource_seed" }> = {
			kind: "discovery_resource_seed",
			message:
				"The requested seed was used as a discovery resource, not captured as an exact page.",
			pagesWritten: seed.pagesWritten ?? 0,
		};
		if (seed.source) warning.source = seed.source;
		return [warning];
	}
	if (seed.redirected) {
		const warning: Extract<RunWarning, { kind: "seed_redirected" }> = {
			kind: "seed_redirected",
			message: "The requested seed redirected before capture.",
		};
		if (seed.url) warning.url = seed.url;
		if (seed.finalUrl) warning.finalUrl = seed.finalUrl;
		return [warning];
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
			...seedLocation(url, output.finalUrl),
			outputPath: output.outputPath,
			source: output.source,
		};
	}
	const attempted = records.find((record) => record.wasSeed);
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
		const summary: SeedSummary = {
			attempted: true,
			included: false,
			...seedLocation(
				attempted.url,
				attempted.finalUrl,
				attempted.redirects.length > 0,
			),
			source: attempted.source,
			omissionReason: "failed",
			failureKind: attempted.failureKind,
			error: attempted.error,
		};
		if (resource) summary.kind = "discovery_resource";
		return summary;
	}
	const summary: SeedSummary = {
		attempted: true,
		included: false,
		...seedLocation(
			attempted.url,
			attempted.finalUrl,
			attempted.redirects.length > 0,
		),
		source: attempted.source,
		omissionReason: "not_written",
	};
	if (resource) summary.kind = "discovery_resource";
	return summary;
}

function seedLocation(
	url: string,
	finalUrl: string,
	redirected = url !== finalUrl,
) {
	const location: Pick<SeedSummary, "url" | "finalUrl" | "redirected"> = {
		url,
		finalUrl,
	};
	if (redirected) location.redirected = true;
	return location;
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

function emptyCounts<T extends string>(keys: readonly T[]) {
	// SAFETY: every key from the generic input is emitted exactly once with a number value.
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
