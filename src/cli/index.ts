import { runPipeline } from "../core/pipeline.ts";
import type { CliOptions, PipelineConfig, RunSummary } from "../core/types.ts";
import { runFiles } from "../output/files.ts";
import { buildPipelineConfig, flagTakesValue, parseArgs } from "./args.ts";
import { logLine, printSummary } from "./progress.ts";

export async function runCli(argv: string[]): Promise<void> {
	try {
		if (argv[0] === "mcp") {
			const { runMcpServer } = await import("../mcp/server.ts");
			await runMcpServer(argv.slice(1));
			return;
		}
		const parsed = parseArgs(await normalizeArgv(argv));
		if ("help" in parsed) {
			process.stdout.write(`${parsed.help}\n`);
			return;
		}
		if ("version" in parsed) {
			process.stdout.write(`${await version()}\n`);
			return;
		}
		const { run, cli } = parsed;
		const config = buildPipelineConfig(run);
		const progress = cli.quiet || cli.json ? undefined : logLine;
		if (config.ignoreRobots)
			logLine("docsnap: warning: --ignore-robots bypasses robots.txt rules");
		const result = await runPipeline(config, progress);
		const ok = runOk(result.summary, cli);
		if (cli.json) {
			process.stdout.write(
				`${JSON.stringify(jsonResult(result.summary, config, ok))}\n`,
			);
		}
		if (!cli.quiet && !cli.json) printSummary(result.summary);
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
			"--stdin cannot be used with a URL argument\n\nTry: echo https://react.dev/reference | docsnap --stdin",
		);
	if (process.stdin.isTTY)
		throw new Error(
			"No URL received on stdin\n\nTry: echo https://react.dev/reference | docsnap --stdin",
		);
	const seedUrl = (await Bun.stdin.text()).trim().split(/\s+/)[0];
	if (!seedUrl)
		throw new Error(
			"No URL received on stdin\n\nTry: echo https://react.dev/reference | docsnap --stdin",
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

function runOk(summary: RunSummary, cli: CliOptions) {
	return (
		summary.written > 0 &&
		(!cli.failOnLowQuality || summary.lowQuality === 0) &&
		(!cli.failOnInjectionSignal || summary.injectionSignalPages === 0)
	);
}

function jsonResult(summary: RunSummary, config: PipelineConfig, ok: boolean) {
	return {
		ok,
		...summary,
		paths: config.dryRun
			? undefined
			: {
					summary: `${summary.outDir}/${runFiles.summary}`,
					manifest: `${summary.outDir}/${runFiles.manifest}`,
					agentReadme: `${summary.outDir}/${runFiles.agentReadme}`,
					tree: `${summary.outDir}/${runFiles.tree}`,
				},
		...(config.agentFiles
			? { agentFilesUpdated: summary.agentFilesUpdated ?? [] }
			: {}),
	};
}

async function version() {
	const packageJson = await Bun.file(
		new URL("../../package.json", import.meta.url),
	).json();
	return packageJson.version;
}
