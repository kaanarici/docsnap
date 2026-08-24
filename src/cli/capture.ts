import { join } from "node:path";
import {
	buildPipelineConfig,
	buildRefreshConfig,
	type ConfigInput,
} from "../core/config.ts";
import { runPipeline } from "../core/pipeline.ts";
import { assertRefreshSelection } from "../core/refresh.ts";
import {
	type CliOptions,
	type PipelineConfig,
	type RunSummary,
	runSucceeded,
} from "../core/types.ts";
import { readSummary } from "../corpus/index.ts";
import { runFiles } from "../output/files.ts";
import type { RefreshInput } from "./args.ts";
import { logLine, printSummary } from "./progress.ts";

export async function runCapture(input: ConfigInput, cli: CliOptions) {
	await runConfiguredCapture(buildPipelineConfig(input), cli);
}

export async function runRefresh(input: RefreshInput, cli: CliOptions) {
	const prior = await readSummary(input.outputDir);
	assertRefreshSelection(prior);
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
	const progress = cli.quiet || cli.json ? undefined : logLine;
	const { summary } = await runPipeline(config, progress);
	const ok =
		runSucceeded(summary) &&
		(!cli.failOnLowQuality || summary.lowQuality === 0) &&
		(!cli.failOnInjectionSignal || summary.injectionSignalPages === 0);
	if (cli.json) {
		process.stdout.write(`${JSON.stringify(captureResult(summary, ok))}\n`);
	}
	if (!cli.quiet && !cli.json) printSummary(summary);
	if (!ok) process.exitCode = 1;
}

type CaptureResult = {
	ok: boolean;
	status: RunSummary["status"];
	seedUrl: string;
	outputDir: string;
	written: number;
	failed: number;
	lowQuality: number;
	maxReached: boolean;
	discoveryTruncated?: true;
	stopReason?: RunSummary["stopReason"];
	qualityWarnings?: number;
	injectionSignalPages?: number;
	byFailureKind?: RunSummary["byFailureKind"];
	errors?: RunSummary["errors"];
	errorsOmitted?: number;
	elapsedMs: number;
	paths?: { summary: string; manifest: string };
};

function captureResult(summary: RunSummary, ok: boolean): CaptureResult {
	const errors = summary.errors.slice(0, 3);
	const errorsOmitted =
		(summary.errorsOmitted ?? 0) + summary.errors.length - errors.length;
	const result: CaptureResult = {
		ok,
		status: summary.status,
		seedUrl: summary.seedUrl,
		outputDir: summary.outDir,
		written: summary.written,
		failed: summary.failed,
		lowQuality: summary.lowQuality,
		maxReached: summary.maxReached,
		elapsedMs: summary.elapsedMs,
	};
	if (summary.discoveryTruncated) result.discoveryTruncated = true;
	if (summary.stopReason) result.stopReason = summary.stopReason;
	if (summary.qualityWarnings) result.qualityWarnings = summary.qualityWarnings;
	if (summary.injectionSignalPages)
		result.injectionSignalPages = summary.injectionSignalPages;
	if (Object.keys(summary.byFailureKind).length)
		result.byFailureKind = summary.byFailureKind;
	if (errors.length) result.errors = errors;
	if (errorsOmitted) result.errorsOmitted = errorsOmitted;
	if (!summary.dryRun) {
		result.paths = {
			summary: join(summary.outDir, runFiles.summary),
			manifest: join(summary.outDir, runFiles.manifest),
		};
	}
	return result;
}
