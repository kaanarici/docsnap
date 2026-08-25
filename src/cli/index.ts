import packageJson from "../../package.json";
import { terminalText } from "../core/text.ts";
import { flagTakesValue, parseArgs } from "./args.ts";

let outputGuardInstalled = false;
const noStdinUrl =
	"No URL received on stdin\n\nTry: echo https://react.dev/reference | docsnap --stdin";

export async function runCli(argv: string[]): Promise<void> {
	installOutputGuard();
	try {
		const parsed = parseArgs(await normalizeArgv(argv));
		if (parsed.kind === "help") {
			process.stdout.write(`${parsed.help}\n`);
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
		if (wantsJsonError(argv)) {
			process.stdout.write(
				`${JSON.stringify({ ok: false, status: "error", error: message.split("\n", 1)[0] ?? message })}\n`,
			);
		} else {
			process.stderr.write(`${terminalText(message)}\n`);
		}
		process.exitCode = 1;
	}
}

function wantsJsonError(argv: string[]) {
	if (argv[0] === "map" || argv[0] === "fetch" || argv[0] === "search") {
		const queryStart = argv.indexOf("--");
		const flags = queryStart >= 0 ? argv.slice(0, queryStart) : argv;
		return flags.includes("--json");
	}
	return argv.includes("--json");
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
