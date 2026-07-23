import { buildPipelineConfig } from "../core/config.ts";
import { runPipeline } from "../core/pipeline.ts";
import { assertRefreshSelection } from "../core/refresh.ts";
import type { CliOptions } from "../core/types.ts";
import { readSummary } from "../corpus/index.ts";
import type { RefreshInput } from "./args.ts";
import { pipelineJson, pipelineOk } from "./pipeline-output.ts";
import { logLine, printSummary } from "./progress.ts";

export async function runRefresh(
	input: RefreshInput,
	cli: CliOptions,
): Promise<void> {
	const prior = await readSummary(input.outputDir);
	assertRefreshSelection(prior);
	const config = buildPipelineConfig({
		seedUrl: prior.seedUrl,
		outDir: input.outputDir,
		max: input.max ?? prior.max,
		maxExplicit: input.max !== undefined ? true : prior.maxAppliesTo === "all",
		...(input.concurrency !== undefined
			? { concurrency: input.concurrency }
			: {}),
		cache: input.cache,
		pageOnly: prior.captureMode === "page",
		userAgent: prior.userAgent,
	});
	const progress = cli.quiet || cli.json ? undefined : logLine;
	const result = await runPipeline(config, progress);
	const ok = pipelineOk(result.summary, cli);
	if (cli.json) {
		process.stdout.write(
			`${JSON.stringify(pipelineJson(result.summary, ok))}\n`,
		);
	}
	if (!cli.quiet && !cli.json) printSummary(result.summary);
	if (!ok) process.exitCode = 1;
}
