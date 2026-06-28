import { join } from "node:path";
import { nextCaptureMax } from "../core/config.ts";
import {
	type CliOptions,
	canBroadenAfterFailure,
	canRetryAfterFailure,
	type RunSummary,
	runSucceeded,
} from "../core/types.ts";
import {
	inspectSummaryCommand,
	corpusCommands as sharedCorpusCommands,
} from "../output/commands.ts";
import { runFiles } from "../output/files.ts";

export function pipelineOk(summary: RunSummary, cli: CliOptions) {
	return (
		runSucceeded(summary) &&
		(!cli.failOnLowQuality || summary.lowQuality === 0) &&
		(!cli.failOnInjectionSignal || summary.injectionSignalPages === 0)
	);
}

export function pipelineJson(summary: RunSummary, ok: boolean) {
	const commands = corpusCommands(summary);
	const actions = nextActions(summary, ok);
	return {
		ok,
		...summary,
		paths: summary.dryRun
			? undefined
			: {
					summary: artifactPath(summary, runFiles.summary),
					manifest: artifactPath(summary, runFiles.manifest),
				},
		...(commands ? { commands } : {}),
		...(actions.length ? { next_actions: actions } : {}),
	};
}

function artifactPath(summary: RunSummary, file: string) {
	return join(summary.outDir, ".", file);
}

function nextActions(summary: RunSummary, ok: boolean) {
	const actions: string[] = [];
	if (summary.dryRun) return actions;
	const commands = corpusCommands(summary);
	if (!ok) {
		actions.push(
			`Inspect run record with ${inspectSummaryCommand(summary.outDir)}`,
		);
		if (commands && "inspect_summary" in commands) {
			if ("retry_capture" in commands) {
				actions.push(
					`Retry capture after inspecting with ${commands.retry_capture}`,
				);
			} else if (!("capture_site" in commands)) {
				actions.push("Choose another reachable public docs URL.");
			}
			if ("capture_site" in commands) {
				actions.push(
					`If the exact page is too narrow, try site discovery with ${commands.capture_site}`,
				);
			}
		}
	}
	if (commands && "capture_more" in commands)
		actions.push(`Capture more pages with ${commands.capture_more}`);
	if (commands && "files" in commands) {
		actions.push(
			`List captured Markdown files with ${commands.files}`,
			...("read_seed" in commands
				? [`Read the captured seed page with ${commands.read_seed}`]
				: []),
			`Raw grep captured Markdown with ${commands.raw_search}`,
			`Fetch cited local context with ${commands.fetch}`,
			`Search local corpus with ${commands.search}`,
		);
		if (!summary.refresh.enabled)
			actions.push(`Refresh local corpus with ${commands.refresh}`);
	}
	return actions;
}

function corpusCommands(summary: RunSummary) {
	if (summary.dryRun) return undefined;
	const nextMax = summary.maxReached ? nextCaptureMax(summary.max) : undefined;
	return sharedCorpusCommands({
		seedUrl: summary.seedUrl,
		outputDir: summary.outDir,
		captureMode: summary.captureMode,
		written: summary.written,
		maxReached: nextMax !== undefined,
		maxPages: nextMax ?? summary.max,
		...(summary.seed.outputPath
			? { seedOutputPath: summary.seed.outputPath }
			: {}),
		retryCapture: canRetryAfterFailure(summary.seed.failureKind),
		siteRetry: canBroadenAfterFailure(summary.seed.failureKind),
	});
}
