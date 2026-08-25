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
import type { RefreshInput } from "./args.ts";
import { logLine, printSummary } from "./progress.ts";

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
	const progress = cli.quiet || cli.json ? undefined : logLine;
	const { summary } = await runPipeline(config, progress);
	const ok =
		runSucceeded(summary) &&
		(!cli.failOnInjectionSignal || summary.injectionSignalPages === 0);
	if (cli.json) {
		process.stdout.write(`${JSON.stringify(captureResult(summary, ok))}\n`);
	}
	if (!cli.quiet && !cli.json) printSummary(summary);
	if (!ok) process.exitCode = 1;
}

function captureResult(summary: RunSummary, ok: boolean) {
	return {
		ok,
		status: summary.status,
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
