import { flagTakesValue, parseArgs } from "./args.ts";
import { runCapture } from "./capture.ts";
import { runFetch } from "./fetch.ts";
import { runList } from "./list.ts";
import { runRefresh } from "./refresh.ts";
import { runSearch } from "./search.ts";

export async function runCli(argv: string[]): Promise<void> {
	try {
		if (argv[0] === "mcp") {
			if (argv.includes("-h") || argv.includes("--help")) {
				process.stdout.write(
					"Usage:\n  docsnap mcp    run local stdio MCP server\n",
				);
				return;
			}
			if (argv.includes("-v") || argv.includes("--version")) {
				process.stdout.write(`${await version()}\n`);
				return;
			}
			if (argv.length > 1) {
				process.stderr.write("docsnap mcp does not accept flags\n");
				process.exitCode = 1;
				return;
			}
			const { runJsonRpcServer } = await import("../mcp/jsonrpc.ts");
			await runJsonRpcServer({
				version: await version(),
				state: { corpora: new Set(), resourceCorpora: new Map() },
			});
			return;
		}
		const parsed = parseArgs(await normalizeArgv(argv));
		if (parsed.kind === "help") {
			process.stdout.write(`${parsed.help}\n`);
			return;
		}
		if (parsed.kind === "version") {
			process.stdout.write(`${await version()}\n`);
			return;
		}
		if (parsed.kind === "list") {
			await runList(parsed.list);
			return;
		}
		if (parsed.kind === "search") {
			await runSearch(parsed.search);
			return;
		}
		if (parsed.kind === "fetch") {
			await runFetch(parsed.fetch);
			return;
		}
		if (parsed.kind === "refresh") {
			await runRefresh(parsed.refresh, parsed.cli);
			return;
		}
		await runCapture(parsed.run, parsed.cli);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (wantsJsonError(argv)) {
			process.stdout.write(
				`${JSON.stringify({ ok: false, status: "error", error: message })}\n`,
			);
		} else {
			process.stderr.write(`${message}\n`);
		}
		process.exitCode = 1;
	}
}

function wantsJsonError(argv: string[]) {
	if (argv[0] === "fetch" || argv[0] === "search") {
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

function isSubcommand(command: string | undefined) {
	return (
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

async function version() {
	const packageJson = await Bun.file(
		new URL("../../package.json", import.meta.url),
	).json();
	return packageJson.version;
}
