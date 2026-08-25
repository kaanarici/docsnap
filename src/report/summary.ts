import { type SnapshotStats, snapshotSchemaVersion } from "../core/snapshot.ts";
import type {
	DiscoveryResourceSeed,
	FailureKind,
	PageOutput,
	PageRecord,
	PipelineConfig,
	RefreshSummary,
	RunSummary,
	SeedSummary,
} from "../core/types.ts";
import { classifyDiscoveryResource } from "../core/url.ts";
import { isLowQuality } from "../extract/quality.ts";

const maxSummaryErrors = 3;

export function buildSummary(
	records: PageRecord[],
	outputs: PageOutput[],
	config: PipelineConfig,
	snapshot: SnapshotStats,
	refresh?: RefreshSummary,
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
	const byFailureKind: Partial<Record<FailureKind, number>> = {};
	const errors: RunSummary["errors"] = [];

	for (const record of records) {
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
		if (isLowQuality(record.qualityReasons)) lowQuality++;
		else if (record.qualityReasons.length) qualityWarnings++;
		if (record.injectionSignals.length) injectionSignalPages++;
	}
	const reached = !config.pageOnly && maxEligible >= config.max;
	const seed = seedSummary(records, outputs, config, seedResource);
	const partial =
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
		written,
		failed,
		lowQuality,
		qualityWarnings,
		injectionSignalPages,
		byFailureKind,
		errors,
	};
	if (refresh?.enabled) summary.refresh = refresh;
	if (failed > errors.length) summary.errorsOmitted = failed - errors.length;
	if (stopReason) summary.stopReason = stopReason;
	if (render) summary.render = render;
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
