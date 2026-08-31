import { basename, join, resolve } from "node:path";
import {
	buildPipelineConfig,
	buildRefreshConfig,
	type ConfigInput,
} from "../core/config.ts";
import { InputError } from "../core/input-error.ts";
import { runBounded } from "../core/parallel.ts";
import { runPipeline } from "../core/pipeline.ts";
import {
	type PipelineConfig,
	type RunSummary,
	runSucceeded,
} from "../core/types.ts";
import { runFiles } from "../output/files.ts";
import {
	readRefreshSummary,
	summaryFailure,
	summaryOutcome,
} from "../report/summary.ts";
import type { RefreshInput } from "./args.ts";
import { failureResult, successResult, writeResult } from "./result.ts";

export async function runCapture(input: ConfigInput, signal?: AbortSignal) {
	await runConfiguredCapture(buildPipelineConfig(input), signal);
}

export async function runBatchCapture(
	inputs: ConfigInput[],
	signal?: AbortSignal,
) {
	const configs = batchConfigs(inputs);
	const totalConcurrency = configs[0]!.concurrency;
	const workers = Math.min(4, configs.length, totalConcurrency);
	const perCorpus = Math.max(1, Math.floor(totalConcurrency / workers));
	for (const config of configs) {
		config.concurrency = perCorpus;
		config.perOrigin = Math.min(config.perOrigin, perCorpus);
	}
	const responses = await runBounded(
		configs.map((config, index) => ({ config, index })),
		{
			concurrency: workers,
			perOrigin: workers,
			key: () => "batch",
		},
		async ({ config }) => {
			try {
				return await captureResponse(config, signal);
			} catch (error) {
				if (signal?.aborted) throw error;
				const message = error instanceof Error ? error.message : String(error);
				return failureResult({
					code: "DOCSNAP_ERROR",
					message,
					next: "Fix the reported cause before retrying this URL.",
					retryable: false,
				});
			}
		},
	);
	signal?.throwIfAborted();
	const results = responses.map((response, index) => ({
		seedUrl: configs[index]!.seedUrl,
		...response,
	}));
	const succeeded = responses.filter((response) => response.ok).length;
	const failed = responses.length - succeeded;
	const data = { total: responses.length, succeeded, failed, results };
	if (failed === 0) {
		writeResult(
			successResult(
				data,
				`Captured ${succeeded} corpora.`,
				"Use each outputDir as a separate Markdown corpus.",
			),
		);
		return;
	}
	writeResult(
		failureResult({
			code: "BATCH_FAILED",
			message: `Captured ${succeeded} of ${responses.length} corpora. ${failed} failed.`,
			next: "Use completed corpora. Retry only failed URLs after fixing their reported cause.",
			retryable: false,
			details: data,
		}),
	);
	process.exitCode = 1;
}

export async function runRefresh(input: RefreshInput, signal?: AbortSignal) {
	signal?.throwIfAborted();
	const prior = await refreshSource(input.outputDir);
	await runConfiguredCapture(
		buildRefreshConfig(prior, {
			outDir: input.outputDir,
			max: input.max,
			concurrency: input.concurrency,
			cache: input.cache,
		}),
		signal,
	);
}

async function refreshSource(outputDir: string) {
	try {
		return await readRefreshSummary(outputDir);
	} catch (error) {
		throw new InputError(
			error instanceof Error ? error.message : String(error),
			"Pass a readable DocSnap corpus directory containing summary.json, or capture it first.",
		);
	}
}

async function runConfiguredCapture(
	config: PipelineConfig,
	signal?: AbortSignal,
) {
	const response = await captureResponse(config, signal);
	signal?.throwIfAborted();
	writeResult(response);
	if (!response.ok) process.exitCode = 1;
}

async function captureResponse(config: PipelineConfig, signal?: AbortSignal) {
	const { summary } = await runPipeline(config, signal);
	const ok = runSucceeded(summary);
	const data = captureData(summary);
	const outcome = summaryOutcome(summary);
	const failure = ok ? null : captureError(summary, outcome);
	return failure
		? failureResult(failure, outcome.warnings)
		: successResult(data, outcome.message, outcome.next, outcome.warnings);
}

function batchConfigs(inputs: ConfigInput[]) {
	const configs = inputs.map((input) => {
		const { outDir, ...withoutOutDir } = input;
		const config = buildPipelineConfig(withoutOutDir);
		if (outDir !== undefined)
			config.outDir = join(outDir, basename(config.outDir));
		return config;
	});
	const outputs = new Map<string, string>();
	for (const config of configs) {
		const output = resolve(config.outDir);
		const prior = outputs.get(output);
		if (prior) {
			throw new InputError(
				`Batch URLs resolve to the same output directory: ${prior} and ${config.seedUrl}`,
				"Capture duplicate URLs separately with distinct --out directories.",
			);
		}
		outputs.set(output, config.seedUrl);
	}
	return configs;
}

function captureData(summary: RunSummary) {
	return {
		seedUrl: summary.seedUrl,
		outputDir: summary.outDir,
		written: summary.written,
		failed: summary.failed,
		lowQuality: summary.lowQuality,
		qualityWarnings: summary.qualityWarnings || undefined,
		maxReached: summary.maxReached,
		discoveryTruncated: summary.discoveryTruncated || undefined,
		stopReason: summary.stopReason,
		retryAt: summary.retryAt,
		byFailureKind:
			Object.keys(summary.byFailureKind).length > 0
				? summary.byFailureKind
				: undefined,
		errors: summary.errors.length ? summary.errors : undefined,
		errorsOmitted: summary.errorsOmitted,
		changes: refreshChanges(summary.refresh),
		paths: {
			summary: join(summary.outDir, runFiles.summary),
			manifest: join(summary.outDir, runFiles.manifest),
		},
	};
}

function refreshChanges(refresh: RunSummary["refresh"]) {
	if (!refresh?.enabled) return;
	return {
		new: refresh.new,
		changed: refresh.changed,
		unchanged: refresh.unchanged,
		removed: refresh.removed,
		pages: refresh.changedPages.map((page) => ({
			change: page.change,
			path: page.outputPath ?? page.previousOutputPath,
		})),
	};
}

function captureError(
	summary: RunSummary,
	outcome: ReturnType<typeof summaryOutcome>,
) {
	return {
		...summaryFailure(summary),
		message: outcome.message,
		next: outcome.next,
		details: captureData(summary),
	};
}
