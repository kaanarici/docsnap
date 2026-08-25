import { join } from "node:path";
import {
	buildPipelineConfig,
	buildRefreshConfig,
	type ConfigInput,
} from "../core/config.ts";
import { runPipeline } from "../core/pipeline.ts";
import {
	type CliOptions,
	type PipelineConfig,
	type RunSummary,
	runSucceeded,
} from "../core/types.ts";
import { readSummary } from "../corpus/index.ts";
import { runFiles } from "../output/files.ts";
import { summaryWarnings } from "../report/summary.ts";
import type { RefreshInput } from "./args.ts";
import { logLine } from "./progress.ts";
import { failureResult, successResult, writeResult } from "./result.ts";

export async function runCapture(input: ConfigInput, cli: CliOptions) {
	await runConfiguredCapture(buildPipelineConfig(input), cli);
}

export async function runRefresh(input: RefreshInput, cli: CliOptions) {
	const prior = await readSummary(input.outputDir);
	await runConfiguredCapture(
		buildRefreshConfig(prior, {
			outDir: input.outputDir,
			max: input.max,
			concurrency: input.concurrency,
			cache: input.cache,
		}),
		cli,
	);
}

async function runConfiguredCapture(config: PipelineConfig, cli: CliOptions) {
	const progress = cli.quiet ? undefined : logLine;
	const { summary } = await runPipeline(config, progress);
	const ok =
		runSucceeded(summary) &&
		(!cli.failOnInjectionSignal || summary.injectionSignalPages === 0);
	const data = captureData(summary);
	const warnings = summaryWarnings(summary);
	const error = ok ? null : captureError(summary, cli.failOnInjectionSignal);
	writeResult(
		error
			? failureResult(error, error.suggestion, warnings)
			: successResult(data, summary.message, summary.next, warnings),
	);
	if (!ok) process.exitCode = 1;
}

function captureData(summary: RunSummary) {
	return {
		seedUrl: summary.seedUrl,
		outputDir: summary.outDir,
		written: summary.written,
		failed: summary.failed,
		lowQuality: summary.lowQuality,
		maxReached: summary.maxReached,
		discoveryTruncated: summary.discoveryTruncated || undefined,
		stopReason: summary.stopReason,
		qualityWarnings: summary.qualityWarnings || undefined,
		injectionSignalPages: summary.injectionSignalPages || undefined,
		byFailureKind:
			Object.keys(summary.byFailureKind).length > 0
				? summary.byFailureKind
				: undefined,
		errors: summary.errors.length ? summary.errors : undefined,
		errorsOmitted: summary.errorsOmitted,
		paths: summary.dryRun
			? undefined
			: {
					summary: join(summary.outDir, runFiles.summary),
					manifest: join(summary.outDir, runFiles.manifest),
				},
	};
}

function captureError(summary: RunSummary, failOnInjectionSignal: boolean) {
	if (failOnInjectionSignal && summary.injectionSignalPages > 0) {
		return {
			code: "INJECTION_SIGNAL",
			message: `Captured ${summary.written} pages, but ${summary.injectionSignalPages} contained prompt-like text.`,
			retryable: false,
			suggestion:
				"Review the flagged pages before using them, or rerun without --fail-on-injection-signal.",
			details: captureData(summary),
		};
	}
	if (summary.stopReason === "rate_limited") {
		return {
			code: "RATE_LIMITED",
			message: summary.message,
			retryable: true,
			suggestion: summary.next,
			details: captureData(summary),
		};
	}
	return {
		code: summary.seed.failureKind?.toUpperCase() ?? "CAPTURE_FAILED",
		message: summary.message,
		retryable:
			summary.seed.failureKind === "timeout" ||
			summary.seed.failureKind === "fetch",
		suggestion: summary.next,
		details: captureData(summary),
	};
}
