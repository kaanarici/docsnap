import { statSync } from "node:fs";
import { type ConfigInput, maxGeneratedCapturePages } from "../core/config.ts";
import type { CliOptions } from "../core/types.ts";

export const maxSearchResults = 50;
const maxListResults = 100;
const minContextChars = 120;
const maxContextChars = 1200;
const fetchScopes = ["page", "site", "auto"] as const;
const freshnessModes = ["reuse", "refresh", "force"] as const;
const valueFlags = new Set([
	"-o",
	"--out",
	"-m",
	"--max",
	"--concurrency",
	"--user-agent",
]);

const usage = `Usage:
  docsnap <url> [flags]
  docsnap fetch <url> [question] [flags]
  docsnap refresh <corpus-dir> [flags]
  docsnap list [root=./docsnap] [flags]
  docsnap search <corpus-dir> <query> [flags]
  docsnap search [root=./docsnap] <query> --all [flags]
  docsnap mcp                  run local stdio MCP server

Flags:
  -o, --out <dir>           output dir; relative paths must stay under the current directory
  -m, --max <count>         max pages; default all llms.txt pages, otherwise 50
  --concurrency <n>         fetch concurrency, CPU-scaled default up to 64
  --clean                   remove output dir before writing
  --dry-run                 run without writing files
  --page                    capture only the given page after robots.txt check
  --site                    force site discovery for a specific page URL
  --no-cache                disable the shared fetch cache for this run
  --json                    print one machine-readable result
  --quiet                   suppress progress logs
  --stdin                   read the URL from stdin
  --user-agent <value>      custom User-Agent
  --fail-on-low-quality     exit non-zero when low-quality pages are found
  --fail-on-injection-signal exit non-zero when injection signal pages are found
  -v, --version             show version
  -h, --help                show help

Run "docsnap fetch --help", "docsnap refresh --help", "docsnap list --help", or "docsnap search --help" for subcommand flags.`;

const fetchUsage = `Usage:
  docsnap fetch <url> [question] [flags]

Flags:
  -o, --out <dir>           local corpus dir; defaults to docsnap's normal slug
  -m, --max <count>         max pages for site captures; max 500
  --scope <mode>            page, site, or auto; default auto
  --freshness <mode>        reuse, refresh, or force; default reuse
  --context-chars <count>   chars per cited snippet; default 500, max 1200
  --exclude-injection       omit injection-signal pages
  --no-cache                disable the shared fetch cache when capturing or refreshing
  --json                    print one machine-readable result
  --quiet                   suppress progress logs

Put docsnap flags before --. Tokens after -- are literal question text.
Use -- before question text that starts with a docsnap flag.`;

const refreshUsage = `Usage:
  docsnap refresh <corpus-dir> [flags]

Flags:
  -m, --max <count>         override prior page limit
  --concurrency <n>         fetch concurrency
  --no-cache                disable the shared fetch cache for this run
  --json                    print one machine-readable result
  --quiet                   suppress progress logs`;

const listUsage = `Usage:
  docsnap list [root=./docsnap] [flags]

Flags:
  --limit <count>           max corpora; default 20, max 100
  --cursor <value>          continue from a prior list result
  --json                    print one machine-readable result`;

const searchUsage = `Usage:
  docsnap search <corpus-dir> <query> [flags]
  docsnap search [root=./docsnap] <query> --all [flags]

Flags:
  --limit <count>           max matches; default 8, max 50
  --glob <pattern>          restrict matches to output paths
  --all                     search every corpus under the given root
  --exclude-injection       omit injection-signal pages
  --json                    print one machine-readable result

Put docsnap flags before --. Tokens after -- are literal query text.
Use -- before query text that starts with a docsnap flag.
With --all, pass a path-like or existing root before the query to search outside ./docsnap.`;

type ParsedRun = { kind: "run"; run: ConfigInput; cli: CliOptions };
export type RefreshInput = {
	outputDir: string;
	max?: number;
	concurrency?: number;
	cache: boolean;
};
export type FetchInput = {
	url: string;
	question?: string;
	outputDir?: string;
	maxPages?: number;
	scope: (typeof fetchScopes)[number];
	freshness: (typeof freshnessModes)[number];
	contextChars: number;
	excludeInjection: boolean;
	cache: boolean;
	json: boolean;
	quiet: boolean;
};
export type SearchInput = {
	outputDir: string;
	query: string;
	limit: number;
	json: boolean;
	all: boolean;
	excludeInjection: boolean;
	pathGlob?: string;
};
export type ListInput = {
	rootDir: string;
	limit: number;
	cursor?: string;
	json: boolean;
};
type ParsedArgs =
	| ParsedRun
	| { kind: "fetch"; fetch: FetchInput }
	| { kind: "refresh"; refresh: RefreshInput; cli: CliOptions }
	| { kind: "list"; list: ListInput }
	| { kind: "search"; search: SearchInput }
	| { kind: "help"; help: string }
	| { kind: "version"; version: true };

export function flagTakesValue(flag: string): boolean {
	return valueFlags.has(flag);
}

export function parseArgs(argv: string[]): ParsedArgs {
	if (argv[0] === "fetch") return parseFetchArgs(argv.slice(1));
	if (argv[0] === "refresh") return parseRefreshArgs(argv.slice(1));
	if (argv[0] === "list") return parseListArgs(argv.slice(1));
	if (argv[0] === "search") return parseSearchArgs(argv.slice(1));
	if (argv.length === 0 || argv.includes("-h") || argv.includes("--help"))
		return { kind: "help", help: usage };
	if (argv.includes("-v") || argv.includes("--version"))
		return { kind: "version", version: true };

	const run: ConfigInput = { seedUrl: "" };
	const cli: CliOptions = {
		json: false,
		quiet: false,
		failOnLowQuality: false,
		failOnInjectionSignal: false,
	};

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
		} else if (arg === "--clean") run.clean = true;
		else if (arg === "--dry-run") run.dryRun = true;
		else if (arg === "--page") run.pageOnly = true;
		else if (arg === "--site") run.site = true;
		else if (arg === "--no-cache") run.cache = false;
		else if (arg === "--json") cli.json = true;
		else if (arg === "--quiet") cli.quiet = true;
		else if (arg === "--user-agent") run.userAgent = readValue(argv, ++i, arg);
		else if (arg === "--fail-on-low-quality") cli.failOnLowQuality = true;
		else if (arg === "--fail-on-injection-signal")
			cli.failOnInjectionSignal = true;
		else throw new Error(`Unknown argument: ${arg}\n\n${usage}`);
	}

	if (!run.seedUrl)
		throw new Error(
			`Missing URL\n\nTry: docsnap https://react.dev/reference --help`,
		);
	if (run.pageOnly && run.site) throw new Error("--page and --site conflict");
	return { kind: "run", run, cli };
}

function parseFetchArgs(argv: string[]): ParsedArgs {
	const queryStart = argv.indexOf("--");
	const flagArgs = queryStart < 0 ? argv : argv.slice(0, queryStart);
	if (flagArgs.includes("-h") || flagArgs.includes("--help")) {
		return { kind: "help", help: fetchUsage };
	}
	const fetch: FetchInput = {
		url: "",
		scope: "auto",
		freshness: "reuse",
		contextChars: 500,
		excludeInjection: false,
		cache: true,
		json: false,
		quiet: false,
	};
	const positional: string[] = [];
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i]!;
		if (arg === "--") {
			positional.push(...argv.slice(i + 1));
			break;
		}
		if (arg === "-o" || arg === "--out")
			fetch.outputDir = readValue(argv, ++i, arg);
		else if (arg === "-m" || arg === "--max") {
			fetch.maxPages = readInt(argv, ++i, arg);
			if (fetch.maxPages > maxGeneratedCapturePages)
				throw new Error(`--max must be ${maxGeneratedCapturePages} or fewer`);
		} else if (arg === "--scope") {
			fetch.scope = readChoice(argv, ++i, arg, fetchScopes);
		} else if (arg === "--freshness") {
			fetch.freshness = readChoice(argv, ++i, arg, freshnessModes);
		} else if (arg === "--context-chars") {
			fetch.contextChars = readInt(argv, ++i, arg);
			if (
				fetch.contextChars < minContextChars ||
				fetch.contextChars > maxContextChars
			) {
				throw new Error(
					`--context-chars must be from ${minContextChars} to ${maxContextChars}`,
				);
			}
		} else if (arg === "--exclude-injection") fetch.excludeInjection = true;
		else if (arg === "--no-cache") fetch.cache = false;
		else if (arg === "--json") fetch.json = true;
		else if (arg === "--quiet") fetch.quiet = true;
		else if (arg.startsWith("-"))
			throw new Error(`Unknown fetch argument: ${arg}\n\n${fetchUsage}`);
		else positional.push(arg);
	}
	fetch.url = positional[0] ?? "";
	const question = positional.slice(1).join(" ").trim();
	if (question) fetch.question = question;
	if (!fetch.url) {
		throw new Error(
			`Missing URL\n\nTry: docsnap fetch https://react.dev/reference/react/useEffect "cleanup function"`,
		);
	}
	return { kind: "fetch", fetch };
}

function parseRefreshArgs(argv: string[]): ParsedArgs {
	if (argv.includes("-h") || argv.includes("--help")) {
		return { kind: "help", help: refreshUsage };
	}
	const refresh: RefreshInput = { outputDir: "", cache: true };
	const cli: CliOptions = {
		json: false,
		quiet: false,
		failOnLowQuality: false,
		failOnInjectionSignal: false,
	};
	const positional: string[] = [];
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i]!;
		if (arg === "-m" || arg === "--max") refresh.max = readInt(argv, ++i, arg);
		else if (arg === "--concurrency")
			refresh.concurrency = readInt(argv, ++i, arg);
		else if (arg === "--no-cache") refresh.cache = false;
		else if (arg === "--json") cli.json = true;
		else if (arg === "--quiet") cli.quiet = true;
		else if (arg.startsWith("-"))
			throw new Error(`Unknown refresh argument: ${arg}\n\n${refreshUsage}`);
		else positional.push(arg);
	}
	refresh.outputDir = positional[0] ?? "";
	if (!refresh.outputDir) {
		throw new Error(
			`Missing corpus directory\n\nTry: docsnap refresh docsnap/react-dev-reference --json`,
		);
	}
	if (positional.length > 1) {
		throw new Error(`Unexpected refresh argument: ${positional[1]}`);
	}
	return { kind: "refresh", refresh, cli };
}

function parseListArgs(argv: string[]): ParsedArgs {
	if (argv.includes("-h") || argv.includes("--help")) {
		return { kind: "help", help: listUsage };
	}
	const list: ListInput = { rootDir: "docsnap", limit: 20, json: false };
	const positional: string[] = [];
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i]!;
		if (arg === "--limit") {
			list.limit = readInt(argv, ++i, arg);
			if (list.limit > maxListResults)
				throw new Error(`--limit must be ${maxListResults} or fewer`);
		} else if (arg === "--cursor") list.cursor = readValue(argv, ++i, arg);
		else if (arg === "--json") list.json = true;
		else if (arg.startsWith("-"))
			throw new Error(`Unknown list argument: ${arg}\n\n${listUsage}`);
		else positional.push(arg);
	}
	if (positional[0]) list.rootDir = positional[0];
	if (positional.length > 1) {
		throw new Error(`Unexpected list argument: ${positional[1]}`);
	}
	return { kind: "list", list };
}

function parseSearchArgs(argv: string[]): ParsedArgs {
	const queryStart = argv.indexOf("--");
	const flagArgs = queryStart < 0 ? argv : argv.slice(0, queryStart);
	if (flagArgs.includes("-h") || flagArgs.includes("--help")) {
		return { kind: "help", help: searchUsage };
	}
	const search: SearchInput = {
		outputDir: "",
		query: "",
		limit: 8,
		json: false,
		all: false,
		excludeInjection: false,
	};
	const positional: string[] = [];
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i]!;
		if (arg === "--") {
			positional.push(...argv.slice(i + 1));
			break;
		}
		if (arg === "--limit") {
			search.limit = readInt(argv, ++i, arg);
			if (search.limit > maxSearchResults) {
				throw new Error(`--limit must be ${maxSearchResults} or fewer`);
			}
		} else if (arg === "--glob") search.pathGlob = readGlob(argv, ++i, arg);
		else if (arg === "--json") search.json = true;
		else if (arg === "--all") search.all = true;
		else if (arg === "--exclude-injection") search.excludeInjection = true;
		else if (arg.startsWith("-"))
			throw new Error(`Unknown search argument: ${arg}\n\n${searchUsage}`);
		else positional.push(arg);
	}
	if (search.all) {
		const explicitRoot = hasAllSearchRoot(positional);
		search.outputDir = explicitRoot ? positional[0]! : "docsnap";
		search.query = positional
			.slice(explicitRoot ? 1 : 0)
			.join(" ")
			.trim();
	} else {
		search.outputDir = positional[0] ?? "";
		search.query = positional.slice(1).join(" ").trim();
	}
	if (!search.outputDir || !search.query) {
		throw new Error(
			`Missing corpus directory/root or query\n\nTry: docsnap search docsnap/react-dev-reference "useEffect cleanup"\nOr: docsnap search --all "signature verification"`,
		);
	}
	return { kind: "search", search };
}

function hasAllSearchRoot(positional: string[]) {
	if (positional.length < 2) return false;
	const first = positional[0]!;
	return looksLikePath(first) || directoryExists(first);
}

function looksLikePath(value: string) {
	return (
		value === "." ||
		value.startsWith("./") ||
		value.startsWith("../") ||
		value.startsWith("/") ||
		/^[a-zA-Z]:[\\/]/.test(value) ||
		value.includes("/") ||
		value.includes("\\")
	);
}

function directoryExists(path: string) {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}

function readValue(argv: string[], index: number, flag: string) {
	const value = argv[index];
	if (!value || value.startsWith("-"))
		throw new Error(`${flag} requires a value`);
	return value;
}

function readGlob(argv: string[], index: number, flag: string) {
	const value = readValue(argv, index, flag);
	if (
		value.length > 200 ||
		value.startsWith("/") ||
		/^[a-zA-Z]:[\\/]/.test(value) ||
		value.split(/[\\/]+/).includes("..")
	) {
		throw new Error(`${flag} must be a simple relative glob`);
	}
	return value;
}

function readInt(argv: string[], index: number, flag: string) {
	const value = Number(readValue(argv, index, flag));
	if (!Number.isInteger(value) || value < 1)
		throw new Error(`${flag} requires a positive integer`);
	return value;
}

function readChoice<T extends string>(
	argv: string[],
	index: number,
	flag: string,
	choices: readonly T[],
): T {
	const value = readValue(argv, index, flag);
	if (choices.includes(value as T)) return value as T;
	throw new Error(`${flag} must be one of: ${choices.join(", ")}`);
}
