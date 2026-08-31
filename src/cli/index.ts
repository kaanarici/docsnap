import packageJson from "../../package.json";
import { InputError } from "../core/input-error.ts";
import { maxPublicUrlChars } from "../security/url.ts";
import { isValueFlag, parseArgs } from "./args.ts";
import { helpData } from "./help.ts";
import { failureResult, successResult, writeResult } from "./result.ts";

let outputGuardInstalled = false;
const stdinNext =
	"Pipe one public URL per line, for example: printf 'https://react.dev\\nhttps://bun.com/docs\\n' | docsnap --stdin";
const maxBatchSeeds = 32;
const maxStdinBytes = maxBatchSeeds * (maxPublicUrlChars + 1);

export async function runCli(argv: string[]): Promise<void> {
	installOutputGuard();
	const cancellation = new AbortController();
	const onSignal = (signal: NodeJS.Signals) => {
		process.exitCode = signal === "SIGINT" ? 130 : 143;
		cancellation.abort(new Error(`Capture cancelled by ${signal}.`));
	};
	process.once("SIGINT", onSignal);
	process.once("SIGTERM", onSignal);
	try {
		const normalized = await normalizeArgv(argv);
		const parsed = parseArgs(normalized.argv);
		if (parsed.kind === "help") {
			writeResult(
				successResult(
					helpData(parsed.help),
					"DocSnap turns public web pages into local Markdown for coding agents.",
					"Run docsnap with a public URL. Use map to inspect candidates or refresh to update an existing corpus.",
				),
			);
			return;
		}
		if (parsed.kind === "version") {
			writeResult(
				successResult(
					{ version: packageJson.version },
					`DocSnap ${packageJson.version}.`,
					"Run docsnap with a public URL to capture Markdown.",
				),
			);
			return;
		}
		if (parsed.kind === "map") {
			const { runMap } = await import("./map.ts");
			await runMap(parsed.map, cancellation.signal);
			return;
		}
		if (parsed.kind === "refresh") {
			const { runRefresh } = await import("./capture.ts");
			await runRefresh(parsed.refresh, cancellation.signal);
			return;
		}
		const { runBatchCapture, runCapture } = await import("./capture.ts");
		if (normalized.seeds) {
			await runBatchCapture(
				normalized.seeds.map((seedUrl) => ({ ...parsed.run, seedUrl })),
				cancellation.signal,
			);
			return;
		}
		await runCapture(parsed.run, cancellation.signal);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (cancellation.signal.aborted) {
			writeResult(
				failureResult({
					code: "CANCELLED",
					message,
					next: "Retry the capture if it was interrupted before completion.",
					retryable: true,
				}),
			);
			return;
		}
		const inputError = error instanceof InputError;
		writeResult(
			failureResult({
				code: inputError ? "INVALID_ARGUMENT" : "DOCSNAP_ERROR",
				message,
				next: inputError
					? error.next
					: "Inspect the error and retry only after its cause is fixed.",
				retryable: false,
			}),
		);
		process.exitCode = inputError ? 2 : 1;
	} finally {
		process.off("SIGINT", onSignal);
		process.off("SIGTERM", onSignal);
	}
}

async function normalizeArgv(
	argv: string[],
): Promise<{ argv: string[]; seeds?: string[] }> {
	const args = argv[0] === "capture" ? argv.slice(1) : argv;
	if (isSubcommand(args[0])) return { argv: args };
	if (!args.includes("--stdin")) return { argv: args };
	const next = args.filter((arg) => arg !== "--stdin");
	if (
		next.includes("-h") ||
		next.includes("--help") ||
		next.includes("-v") ||
		next.includes("--version")
	)
		return { argv: next };
	if (hasSeedArg(next))
		throw new InputError(
			"--stdin cannot be used with a URL argument",
			stdinNext,
		);
	if (process.stdin.isTTY)
		throw new InputError("No URL received on stdin", stdinNext);
	const urls = await readStdinUrls();
	const normalizedArgv = [urls[0]!, ...next];
	return urls.length > 1
		? { argv: normalizedArgv, seeds: urls }
		: { argv: normalizedArgv };
}

async function readStdinUrls(): Promise<string[]> {
	const urls: string[] = [];
	const decoder = new TextDecoder();
	let pending = "";
	let totalBytes = 0;
	for await (const chunk of Bun.stdin.stream()) {
		totalBytes += chunk.byteLength;
		if (totalBytes > maxStdinBytes)
			throw new InputError(
				`--stdin input must be ${maxStdinBytes} bytes or fewer`,
				stdinNext,
			);
		pending += decoder.decode(chunk, { stream: true });
		const lines = pending.split(/\n/);
		pending = lines.pop() ?? "";
		for (const line of lines) consumeStdinLine(line);
		if (pending.length > maxPublicUrlChars)
			throw new InputError(
				`Each stdin URL must be ${maxPublicUrlChars} characters or fewer`,
				stdinNext,
			);
	}
	pending += decoder.decode();
	consumeStdinLine(pending);
	if (urls.length === 0)
		throw new InputError("No URL received on stdin", stdinNext);
	return urls;

	function consumeStdinLine(rawLine: string) {
		const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
		const url = line.trim();
		if (!url) return;
		if (line.length > maxPublicUrlChars)
			throw new InputError(
				`Each stdin URL must be ${maxPublicUrlChars} characters or fewer`,
				stdinNext,
			);
		if (/\s/.test(url))
			throw new InputError(
				"Each stdin line must contain exactly one URL",
				stdinNext,
			);
		urls.push(url);
		if (urls.length > maxBatchSeeds)
			throw new InputError(`--stdin accepts ${maxBatchSeeds} URLs or fewer`);
	}
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
	return command === "map" || command === "refresh";
}

function hasSeedArg(argv: string[]) {
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i]!;
		if (isValueFlag(arg)) {
			i += 1;
			continue;
		}
		if (!arg.startsWith("-")) return true;
	}
	return false;
}
