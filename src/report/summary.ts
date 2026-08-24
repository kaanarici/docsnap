import { cacheSummary } from "../cache/store.ts";
import { captureSelectionHash } from "../core/config.ts";
import { emptyRefreshSummary } from "../core/refresh.ts";
import { type SnapshotStats, snapshotSchemaVersion } from "../core/snapshot.ts";
import {
	type DiscoveredUrl,
	type DiscoveryResourceSeed,
	type DiscoverySource,
	type FailureKind,
	type InjectionSignal,
	type InlineStateSource,
	injectionSignals,
	inlineStateSources,
	lowQualityConfidence,
	type PageExtractor,
	type PageKind,
	type PageOutput,
	type PageRecord,
	type PipelineConfig,
	pageKinds,
	type RefreshSummary,
	type RunSummary,
	type SeedSummary,
} from "../core/types.ts";
import { classifyDiscoveryResource } from "../core/url.ts";

const maxSummaryErrors = 20;

export function buildSummary(
	records: PageRecord[],
	outputs: PageOutput[],
	config: PipelineConfig,
	attempted: DiscoveredUrl[],
	deduped: number,
	snapshot: SnapshotStats,
	elapsedMs: number,
	refresh: RefreshSummary = emptyRefreshSummary(),
	cache = cacheSummary(config),
	seedResource?: DiscoveryResourceSeed,
	discoveryTruncated = false,
	render?: RunSummary["render"],
	stopReason?: RunSummary["stopReason"],
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
	const bySource = {
		seed: 0,
		llms: 0,
		sitemap: 0,
		feed: 0,
		nav: 0,
		crawl: 0,
	} satisfies Record<DiscoverySource, number>;
	const byExtractor = {
		markdown: 0,
		html: 0,
		text: 0,
		fallback: 0,
		structured: 0,
		"inline-state": 0,
	} satisfies Record<PageExtractor, number>;
	const byKind: Partial<Record<PageKind, number>> = {};
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
		if (errors.length < maxSummaryErrors)
			errors.push({
				url: record.url,
				error: record.error,
				failureKind: record.failureKind,
			});
	}

	for (const record of outputs) {
		byExtractor[record.extractor]++;
		if (record.kind) {
			byKind[record.kind] = (byKind[record.kind] ?? 0) + 1;
		}
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
	const partial =
		(failed > 0 && !reached) ||
		!seed.included ||
		lowQuality ||
		stopReason !== undefined ||
		(discoveryTruncated && !reached) ||
		render?.truncated;

	const summary: RunSummary = {
		status: written === 0 ? "failed" : partial ? "partial" : "ok",
		seedUrl: config.seedUrl,
		seed,
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
	if (failed > errors.length) summary.errorsOmitted = failed - errors.length;
	if (stopReason) summary.stopReason = stopReason;
	if (selectionHash) summary.selectionHash = selectionHash;
	if (render) summary.render = render;
	const countedByKind = orderedPartialCounts(byKind, pageKinds);
	if (Object.keys(countedByKind).length) summary.byKind = countedByKind;
	return summary;
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
