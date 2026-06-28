import { buildPipelineConfig, type ConfigInput } from "../core/config.ts";
import { runPipeline } from "../core/pipeline.ts";
import type { CliOptions } from "../core/types.ts";
import { pipelineJson, pipelineOk } from "./pipeline-output.ts";
import { logLine, printSummary } from "./progress.ts";

export async function runCapture(
	input: ConfigInput,
	cli: CliOptions,
): Promise<void> {
	const config = buildPipelineConfig(input);
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
