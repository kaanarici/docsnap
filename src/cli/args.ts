import { type ConfigInput, maxGeneratedCapturePages } from "../core/config.ts";
import { InputError } from "../core/input-error.ts";

const valueFlags = new Set([
	"-o",
	"--out",
	"-m",
	"--max",
	"--concurrency",
	"--include",
	"--exclude",
	"--user-agent",
]);

const usage = `Usage:
  docsnap <url> [flags]
  docsnap capture <url> [flags]
  docsnap map <url> [flags]
  docsnap refresh <corpus-dir> [flags]

Flags:
  -o, --out <dir>           output dir; parent dir when --stdin has several URLs
  -m, --max <count>         max pages; default all llms.txt pages, otherwise 50
  --concurrency <n>         fetch concurrency
  --clean                   remove output dir before writing
  --page                    capture only the supplied page
  --site                    force site discovery for a specific page URL
  --include <path-glob>     keep matching paths; repeatable
  --exclude <path-glob>     skip matching paths; repeatable
  --no-cache                disable the shared fetch cache for this run
  --stdin                   read one URL per line from stdin; max 32
  --user-agent <value>      custom User-Agent
  -v, --version             show version
  -h, --help                show help

Run "docsnap map --help" or "docsnap refresh --help" for subcommand flags.`;

const mapUsage = `Usage:
  docsnap map <url> [flags]

Returns bounded site-capture candidates without extracting or writing a corpus.

Flags:
  -m, --max <count>         max URLs; default 50, max ${maxGeneratedCapturePages}
  --concurrency <n>         fetch concurrency
  --include <path-glob>     keep matching paths; repeatable
  --exclude <path-glob>     skip matching paths; repeatable
  --no-cache                disable the shared fetch cache
  --user-agent <value>      custom User-Agent`;

const refreshUsage = `Usage:
  docsnap refresh <corpus-dir> [flags]

Flags:
  -m, --max <count>         override prior page limit
  --concurrency <n>         fetch concurrency
  --no-cache                disable the shared fetch cache for this run`;

export type RefreshInput = {
	outputDir: string;
	max?: number;
	concurrency?: number;
	cache: boolean;
};
type ParsedArgs =
	| { kind: "run"; run: ConfigInput }
	| { kind: "map"; map: ConfigInput }
	| { kind: "refresh"; refresh: RefreshInput }
	| { kind: "help"; help: string }
	| { kind: "version"; version: true };

export function isValueFlag(flag: string): boolean {
	return valueFlags.has(flag);
}

export function parseArgs(argv: string[]): ParsedArgs {
	if (argv[0] === "map") return parseMapArgs(argv.slice(1));
	if (argv[0] === "refresh") return parseRefreshArgs(argv.slice(1));
	if (argv.length === 0 || argv.includes("-h") || argv.includes("--help"))
		return { kind: "help", help: usage };
	if (argv.includes("-v") || argv.includes("--version"))
		return { kind: "version", version: true };

	const run: ConfigInput = { seedUrl: "" };

	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i]!;
		if (!arg.startsWith("-") && !run.seedUrl) {
			run.seedUrl = arg;
			continue;
		}
		if (arg === "-o" || arg === "--out") {
			run.outDir = readValue(argv, ++i, arg);
		} else if (arg === "-m" || arg === "--max") {
			run.max = readInt(argv, ++i, arg);
		} else if (arg === "--concurrency") {
			run.concurrency = readInt(argv, ++i, arg);
		} else if (arg === "--include") {
			run.include = [...(run.include ?? []), readValue(argv, ++i, arg)];
		} else if (arg === "--exclude") {
			run.exclude = [...(run.exclude ?? []), readValue(argv, ++i, arg)];
		} else if (arg === "--clean") run.clean = true;
		else if (arg === "--page") run.pageOnly = true;
		else if (arg === "--site") run.site = true;
		else if (arg === "--no-cache") run.cache = false;
		else if (arg === "--user-agent") run.userAgent = readValue(argv, ++i, arg);
		else throw new InputError(`Unknown argument: ${arg}`);
	}

	if (!run.seedUrl)
		throw new InputError(
			"Missing URL",
			"Pass a public URL, for example: docsnap https://react.dev/reference",
		);
	if (run.pageOnly && run.site)
		throw new InputError("--page and --site conflict");
	if (run.pageOnly && (run.include?.length || run.exclude?.length))
		throw new InputError("--page cannot be combined with path filters");
	return { kind: "run", run };
}

function parseMapArgs(argv: string[]): ParsedArgs {
	if (argv.includes("-h") || argv.includes("--help")) {
		return { kind: "help", help: mapUsage };
	}
	const config: ConfigInput = {
		seedUrl: "",
		maxExplicit: true,
		site: true,
	};
	const positional: string[] = [];
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i]!;
		if (arg === "-m" || arg === "--max") {
			config.max = readInt(argv, ++i, arg, maxGeneratedCapturePages);
		} else if (arg === "--concurrency")
			config.concurrency = readInt(argv, ++i, arg);
		else if (arg === "--include")
			config.include = [...(config.include ?? []), readValue(argv, ++i, arg)];
		else if (arg === "--exclude")
			config.exclude = [...(config.exclude ?? []), readValue(argv, ++i, arg)];
		else if (arg === "--no-cache") config.cache = false;
		else if (arg === "--user-agent")
			config.userAgent = readValue(argv, ++i, arg);
		else if (arg.startsWith("-"))
			throw new InputError(`Unknown map argument: ${arg}`);
		else positional.push(arg);
	}
	config.seedUrl = positional[0] ?? "";
	if (!config.seedUrl)
		throw new InputError(
			"Missing URL",
			"Pass a public URL, for example: docsnap map https://react.dev",
		);
	if (positional.length > 1)
		throw new InputError(`Unexpected map argument: ${positional[1]}`);
	return { kind: "map", map: config };
}

function parseRefreshArgs(argv: string[]): ParsedArgs {
	if (argv.includes("-h") || argv.includes("--help")) {
		return { kind: "help", help: refreshUsage };
	}
	const refresh: RefreshInput = { outputDir: "", cache: true };
	const positional: string[] = [];
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i]!;
		if (arg === "-m" || arg === "--max") refresh.max = readInt(argv, ++i, arg);
		else if (arg === "--concurrency")
			refresh.concurrency = readInt(argv, ++i, arg);
		else if (arg === "--no-cache") refresh.cache = false;
		else if (arg.startsWith("-"))
			throw new InputError(`Unknown refresh argument: ${arg}`);
		else positional.push(arg);
	}
	refresh.outputDir = positional[0] ?? "";
	if (!refresh.outputDir) {
		throw new InputError(
			"Missing corpus directory",
			"Pass a corpus directory, for example: docsnap refresh docsnap/react-dev-reference",
		);
	}
	if (positional.length > 1) {
		throw new InputError(`Unexpected refresh argument: ${positional[1]}`);
	}
	return { kind: "refresh", refresh };
}

function readValue(argv: string[], index: number, flag: string) {
	const value = argv[index];
	if (!value || value.startsWith("-"))
		throw new InputError(`${flag} requires a value`);
	return value;
}

function readInt(argv: string[], index: number, flag: string, max?: number) {
	const value = Number(readValue(argv, index, flag));
	if (!Number.isInteger(value) || value < 1)
		throw new InputError(`${flag} requires a positive integer`);
	if (max !== undefined && value > max)
		throw new InputError(`${flag} must be ${max} or fewer`);
	return value;
}
