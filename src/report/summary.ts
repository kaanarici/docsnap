import { maxGeneratedCapturePages } from "../core/config.ts";
import {
	isJsonNumber,
	isJsonObject,
	isJsonString,
	parseJsonValue,
} from "../core/json.ts";
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
import { failureCanRetry } from "../core/types.ts";
import { classifyDiscoveryResource } from "../core/url.ts";
import { isLowQuality } from "../extract/quality.ts";
import { corpusGenerator, runFiles } from "../output/files.ts";
import { corpusLimits, readBoundedCorpusFile } from "../output/read.ts";

const maxSummaryErrors = 3;

export function buildSummary(
	records: PageRecord[],
	outputs: PageOutput[],
	config: PipelineConfig,
	refresh?: RefreshSummary,
	seedResource?: DiscoveryResourceSeed,
	discoveryTruncated = false,
	render?: RunSummary["render"],
	stopReason?: RunSummary["stopReason"],
	retryAt?: string,
): RunSummary {
	const written = outputs.length;
	let failed = 0;
	let maxEligible = 0;
	let lowQuality = 0;
	let qualityWarnings = 0;
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
	}
	const reached = !config.pageOnly && maxEligible >= config.max;
	const seed = seedSummary(records, outputs, config, seedResource);
	const ok =
		written > 0 &&
		stopReason === undefined &&
		(!config.pageOnly || seed.included);

	const summary: RunSummary = {
		ok,
		generator: corpusGenerator,
		seedUrl: config.seedUrl,
		seed,
		outDir: config.outDir,
		captureMode: config.pageOnly ? "page" : "site",
		userAgent: config.userAgent,
		generatedAt: new Date().toISOString(),
		max: config.max,
		maxAppliesTo: config.maxExplicit ? "all" : "non-llms",
		maxReached: reached,
		discoveryTruncated,
		written,
		failed,
		lowQuality,
		qualityWarnings,
		byFailureKind,
		errors,
	};
	if (config.include.length) summary.include = config.include;
	if (config.exclude.length) summary.exclude = config.exclude;
	if (refresh?.enabled) summary.refresh = refresh;
	if (failed > errors.length) summary.errorsOmitted = failed - errors.length;
	if (stopReason) summary.stopReason = stopReason;
	if (stopReason === "rate_limited" && retryAt) summary.retryAt = retryAt;
	if (render) summary.render = render;
	return summary;
}

export function summaryOutcome(summary: RunSummary) {
	return {
		message: summaryMessage(summary),
		next: summaryNext(summary),
		warnings: summaryWarnings(summary),
	};
}

export function summaryFailure(summary: RunSummary): {
	code: string;
	retryable: boolean;
} {
	if (summary.stopReason === "rate_limited") {
		return {
			code: "RATE_LIMITED",
			retryable: failureCanRetry(summary.stopReason),
		};
	}
	return {
		code: summary.seed.failureKind?.toUpperCase() ?? "CAPTURE_FAILED",
		retryable: failureCanRetry(summary.seed.failureKind),
	};
}

function summaryMessage(summary: RunSummary): string {
	const pages = `${summary.written} page${summary.written === 1 ? "" : "s"}`;
	if (!summary.ok) {
		if (summary.stopReason === "rate_limited") {
			return `Saved ${pages} before repeated rate limits stopped the capture.`;
		}
		if (summary.captureMode === "page" && !summary.seed.included) {
			return `DocSnap did not capture the requested page. Do not rely on this corpus for that URL.`;
		}
		return "DocSnap did not capture any usable pages. Check the error details before retrying.";
	}
	if (summary.refresh?.enabled) {
		const changes = [
			[summary.refresh.new, "new"],
			[summary.refresh.changed, "changed"],
			[summary.refresh.removed, "removed"],
		]
			.filter(([count]) => count)
			.map(([count, label]) => `${count} ${label}`);
		return changes.length
			? `Refreshed ${pages}. ${changes.join(", ")}.`
			: `Refreshed ${pages}. Nothing changed.`;
	}
	const issues = summaryWarnings(summary);
	if (issues.length) {
		return `Captured ${pages}. The corpus is usable.`;
	}
	if (summary.maxReached) {
		return `Captured the requested limit of ${pages}. More pages may exist.`;
	}
	return `Captured ${pages}.`;
}

function summaryNext(summary: RunSummary): string {
	if (!summary.ok) {
		if (summary.stopReason === "rate_limited") {
			return summary.retryAt
				? `Use the saved pages if incomplete coverage is enough. Otherwise retry at or after ${summary.retryAt}.`
				: "Use the saved pages if incomplete coverage is enough. Otherwise retry later.";
		}
		if (summary.seed.failureKind === "not_found")
			return "Stop. Use a different URL; retrying this URL unchanged will not help.";
		if (summary.seed.failureKind === "blocked")
			return "Stop. Use another public source; retry only if the site's access conditions change.";
		if (failureCanRetry(summary.seed.failureKind))
			return "Retry once. If the same failure repeats, use another source.";
		return "Use a more specific public page or another source; an unchanged retry is unlikely to help.";
	}
	if (summary.lowQuality || summary.failed || !summary.seed.included)
		return "Use the corpus. Check manifest.jsonl only if a missing or low-quality page matters.";
	if (
		(summary.discoveryTruncated && !summary.maxReached) ||
		summary.render?.truncated
	)
		return "Use the corpus for the current task. Increase the limit or capture a specific missing page only if broader coverage matters.";
	if (summary.maxReached)
		return "Use the corpus. Increase the page limit only if broader coverage matters.";
	return `Use the Markdown corpus in ${summary.outDir}.`;
}

function summaryWarnings(summary: RunSummary): string[] {
	const issues: string[] = [];
	if (!summary.seed.included)
		issues.push("The requested URL was not included.");
	if (summary.failed)
		issues.push(
			`${summary.failed} linked page${summary.failed === 1 ? "" : "s"} failed.`,
		);
	if (summary.lowQuality)
		issues.push(
			`${summary.lowQuality} page${summary.lowQuality === 1 ? " is" : "s are"} low quality.`,
		);
	if (summary.discoveryTruncated && !summary.maxReached)
		issues.push("Discovery stopped before the whole site was mapped.");
	if (summary.render?.truncated)
		issues.push("Browser rendering stopped before every candidate was tried.");
	if (summary.render?.unavailable)
		issues.push(
			`Browser rendering was unavailable: ${summary.render.unavailable}.`,
		);
	return issues;
}

export async function readRefreshSummary(outputDir: string) {
	let value: ReturnType<typeof parseJsonValue>;
	try {
		value = parseJsonValue(
			await readBoundedCorpusFile(
				outputDir,
				runFiles.summary,
				corpusLimits.summaryBytes,
			),
		);
	} catch (error) {
		if (error instanceof SyntaxError) {
			throw new Error(`Invalid ${runFiles.summary} in corpus`);
		}
		throw error;
	}
	if (
		!isJsonObject(value) ||
		!isJsonString(value["seedUrl"]) ||
		!isJsonNumber(value["max"]) ||
		!Number.isSafeInteger(value["max"]) ||
		value["max"] < 1 ||
		value["max"] > maxGeneratedCapturePages ||
		(value["maxAppliesTo"] !== "all" && value["maxAppliesTo"] !== "non-llms") ||
		(value["captureMode"] !== "page" && value["captureMode"] !== "site") ||
		!isJsonString(value["userAgent"]) ||
		!isOptionalStringArray(value["include"]) ||
		!isOptionalStringArray(value["exclude"])
	) {
		throw new Error(`Invalid ${runFiles.summary} in corpus`);
	}
	return {
		seedUrl: value["seedUrl"],
		max: value["max"],
		maxAppliesTo: value["maxAppliesTo"],
		captureMode: value["captureMode"],
		userAgent: value["userAgent"],
		include: stringArray(value["include"]),
		exclude: stringArray(value["exclude"]),
	} satisfies Pick<
		RunSummary,
		| "seedUrl"
		| "max"
		| "maxAppliesTo"
		| "captureMode"
		| "userAgent"
		| "include"
		| "exclude"
	>;
}

function stringArray(value: unknown) {
	return Array.isArray(value) && value.every(isJsonString) ? value : [];
}

function isOptionalStringArray(value: unknown) {
	return (
		value === undefined || (Array.isArray(value) && value.every(isJsonString))
	);
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
