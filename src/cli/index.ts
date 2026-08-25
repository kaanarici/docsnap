import packageJson from "../../package.json";
import { CliArgumentError, flagTakesValue, parseArgs } from "./args.ts";
import { helpData } from "./help.ts";
import { failureResult, successResult, writeResult } from "./result.ts";

let outputGuardInstalled = false;
const noStdinUrl =
	"No URL received on stdin\n\nTry: echo https://react.dev/reference | docsnap --stdin";

export async function runCli(argv: string[]): Promise<void> {
	installOutputGuard();
	try {
		const parsed = parseArgs(await normalizeArgv(argv));
		if (parsed.kind === "help") {
			writeResult(
				successResult(
					helpData(parsed.help),
					"DocSnap captures public documentation into local Markdown for coding agents.",
					"Run docsnap with a public URL. Use a subcommand only when you need mapping, retrieval, refresh, listing, or search.",
				),
			);
			return;
		}
		if (parsed.kind === "version") {
			process.stdout.write(`${packageJson.version}\n`);
			return;
		}
		if (parsed.kind === "map") {
			const { runMap } = await import("./map.ts");
			await runMap(parsed.map);
			return;
		}
		if (parsed.kind === "list") {
			const { runList } = await import("./list.ts");
			await runList(parsed.list);
			return;
		}
		if (parsed.kind === "search") {
			const { runSearch } = await import("./search.ts");
			await runSearch(parsed.search);
			return;
		}
		if (parsed.kind === "fetch") {
			const { runFetch } = await import("./fetch.ts");
			await runFetch(parsed.fetch);
			return;
		}
		if (parsed.kind === "refresh") {
			const { runRefresh } = await import("./capture.ts");
			await runRefresh(parsed.refresh, parsed.cli);
			return;
		}
		const { runCapture } = await import("./capture.ts");
		await runCapture(parsed.run, parsed.cli);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (process.exitCode === 130 || process.exitCode === 143) return;
		const usageError =
			error instanceof CliArgumentError ||
			message.startsWith("Unsafe URL:") ||
			message.startsWith("Invalid URL:") ||
			message.includes("--stdin");
		const firstLine = message.split("\n", 1)[0] ?? message;
		const tryLine = message.split("\n").find((line) => line.startsWith("Try:"));
		writeResult(
			failureResult({
				code: usageError ? "INVALID_ARGUMENT" : "DOCSNAP_ERROR",
				message: firstLine,
				retryable: false,
				suggestion:
					tryLine ??
					(usageError
						? "Correct the input and retry. Run docsnap --help if the expected argument is unclear."
						: "Inspect the error and retry only after its cause is fixed."),
			}),
		);
		process.exitCode = usageError ? 2 : 1;
	}
}

async function normalizeArgv(argv: string[]) {
	if (isSubcommand(argv[0])) return argv;
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
	if (process.stdin.isTTY) throw new Error(noStdinUrl);
	const input = (await Bun.stdin.text()).trim();
	if (!input) throw new Error(noStdinUrl);
	const urls = input.split(/\s+/);
	if (urls.length !== 1) throw new Error("--stdin requires exactly one URL");
	return [urls[0]!, ...next];
}

function installOutputGuard() {
	if (outputGuardInstalled) return;
	outputGuardInstalled = true;
	process.stdout.on("error", (error) => {
		if ("code" in error && error.code === "EPIPE") process.exit(0);
		throw error;
	});
}

function isSubcommand(command: string | undefined) {
	return (
		command === "map" ||
		command === "fetch" ||
		command === "search" ||
		command === "refresh" ||
		command === "list"
	);
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
