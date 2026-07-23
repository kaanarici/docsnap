import { join } from "node:path";
import {
	type CliOptions,
	type RunSummary,
	runSucceeded,
} from "../core/types.ts";
import { runFiles } from "../output/files.ts";

export function pipelineOk(summary: RunSummary, cli: CliOptions) {
	return (
		runSucceeded(summary) &&
		(!cli.failOnLowQuality || summary.lowQuality === 0) &&
		(!cli.failOnInjectionSignal || summary.injectionSignalPages === 0)
	);
}

export function pipelineJson(summary: RunSummary, ok: boolean) {
	return {
		ok,
		...summary,
		paths: summary.dryRun
			? undefined
			: {
					summary: artifactPath(summary, runFiles.summary),
					manifest: artifactPath(summary, runFiles.manifest),
				},
	};
}

function artifactPath(summary: RunSummary, file: string) {
	return join(summary.outDir, ".", file);
}
