import { runPipeline } from "../core/pipeline.ts";
import type { Config, RunSummary } from "../core/types.ts";
import { runFiles } from "../output/files.ts";
import { flagTakesValue, parseArgs } from "./args.ts";
import { note, printSummary } from "./progress.ts";

export async function runCli(argv: string[]): Promise<void> {
	try {
		const parsed = parseArgs(await normalizeArgv(argv));
		if ("help" in parsed) {
			process.stdout.write(`${parsed.help}\n`);
			return;
		}
		if ("version" in parsed) {
			process.stdout.write(`${await version()}\n`);
			return;
		}
		const progress = parsed.quiet || parsed.json ? undefined : note;
		const result = await runPipeline(parsed, progress);
		const ok = runOk(result.summary, parsed);
		if (parsed.json) {
			process.stdout.write(
				`${JSON.stringify(jsonResult(result.summary, parsed, ok))}\n`,
			);
		}
		if (!parsed.quiet && !parsed.json) printSummary(result.summary);
		if (!ok) {
			process.exitCode = 1;
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (argv.includes("--json")) {
			process.stdout.write(
				`${JSON.stringify({ ok: false, status: "error", error: message })}\n`,
			);
		} else {
			process.stderr.write(`${message}\n`);
		}
		process.exitCode = 1;
	}
}

async function normalizeArgv(argv: string[]) {
	if (!argv.includes("--stdin")) return argv;
	const next = argv.filter((arg) => arg !== "--stdin");
	if (
		next.includes("-h") ||
		next.includes("--help") ||
		next.includes("-v") ||
		next.includes("--version")
	)
		return next;
	if (hasSeedArg(next))
		throw new Error(
			"--stdin cannot be used with a URL argument\n\nTry: echo https://example.com | docsnap --stdin",
		);
	if (process.stdin.isTTY)
		throw new Error(
			"No URL received on stdin\n\nTry: echo https://example.com | docsnap --stdin",
		);
	const seedUrl = (await Bun.stdin.text()).trim().split(/\s+/)[0];
	if (!seedUrl)
		throw new Error(
			"No URL received on stdin\n\nTry: echo https://example.com | docsnap --stdin",
		);
	return [seedUrl, ...next];
}

function hasSeedArg(argv: string[]) {
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i]!;
		if (flagTakesValue(arg)) {
			i++;
			continue;
		}
		if (!arg.startsWith("-")) return true;
	}
	return false;
}

function runOk(summary: RunSummary, config: Config) {
	return (
		summary.written > 0 &&
		(!config.failOnLowQuality || summary.lowQuality === 0)
	);
}

function jsonResult(summary: RunSummary, config: Config, ok: boolean) {
	return {
		ok,
		status: summary.status,
		seedUrl: summary.seedUrl,
		outDir: summary.outDir,
		dryRun: summary.dryRun,
		paths: config.dryRun
			? undefined
			: {
					summary: `${summary.outDir}/${runFiles.summary}`,
					manifest: `${summary.outDir}/${runFiles.manifest}`,
					agentReadme: `${summary.outDir}/${runFiles.agentReadme}`,
					tree: `${summary.outDir}/${runFiles.tree}`,
				},
		written: summary.written,
		failed: summary.failed,
		lowQuality: summary.lowQuality,
		max: summary.max,
		maxAppliesTo: summary.maxAppliesTo,
		maxReached: summary.maxReached,
		discovered: summary.discovered,
		deduped: summary.deduped,
		elapsedMs: summary.elapsedMs,
		pagesPerSecond: summary.pagesPerSecond,
		bySource: summary.bySource,
		byFailureKind: summary.byFailureKind,
		errors: summary.errors,
		rootHash: summary.rootHash,
		renderedFiles: summary.renderedFiles,
		renderedBytes: summary.renderedBytes,
	};
}

async function version() {
	const packageJson = await Bun.file(
		new URL("../../package.json", import.meta.url),
	).json();
	return packageJson.version;
}
