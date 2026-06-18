import { cpus } from "node:os";
import type {
	CliOptions,
	FetchTransport,
	PipelineConfig,
} from "../core/types.ts";
import { validatePublicHttpUrl } from "../security/url.ts";

const cpuCount = cpus().length;
const defaultConcurrency = Math.min(64, Math.max(16, cpuCount * 6));
const defaultPerOrigin = Math.min(defaultConcurrency, 8);
const defaultUserAgent =
	"Mozilla/5.0 (compatible; docsnap; +https://npmjs.com/package/docsnap)";
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
  docsnap mcp                  run local stdio MCP server

Flags:
  -o, --out <dir>           output dir; relative paths must stay under the current directory
  -m, --max <count>         max pages; default all llms.txt pages, otherwise 50
  --concurrency <n>         fetch concurrency, CPU-scaled default up to 64
  --clean                   remove output dir before writing
  --dry-run                 run without writing files
  --page                    capture only the given page after robots.txt check
  --no-cache                disable the shared fetch cache for this run
  --agent-files             add a docsnap block to AGENTS.md/CLAUDE.md in the current directory
  --json                    print one machine-readable result
  --quiet                   suppress progress logs
  --stdin                   read the URL from stdin
  --ignore-robots           bypass robots.txt rules
  --user-agent <value>      custom User-Agent
  --fail-on-low-quality     exit non-zero when low-quality pages are found
  --fail-on-injection-signal exit non-zero when injection signal pages are found
  -v, --version             show version
  -h, --help                show help

Examples:
  docsnap https://react.dev/reference -o vendor-docs --clean --json
  docsnap https://fly.io/docs/ -m 100 --concurrency 24
  docsnap https://docs.djangoproject.com/en/stable/topics/auth/ --page
  echo https://react.dev/reference | docsnap --stdin --json
  docsnap https://docs.python.org/3/ --dry-run --json
  docsnap https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API --fail-on-low-quality`;

// The typed capture intent shared by every config builder. It is the single
// shape callers populate — the CLI from argv, MCP tools from validated fields —
// before buildPipelineConfig turns it into a PipelineConfig. Absent fields take
// the canonical defaults that live in buildPipelineConfig; presence of `max`
// drives maxExplicit unless `maxExplicit` is set directly (refresh inherits the
// prior run's policy regardless of whether a new max was supplied).
export type ConfigInput = {
	seedUrl: string;
	outDir?: string;
	max?: number;
	maxExplicit?: boolean;
	concurrency?: number;
	clean?: boolean;
	dryRun?: boolean;
	agentFiles?: boolean;
	pageOnly?: boolean;
	ignoreRobots?: boolean;
	cache?: boolean;
	userAgent?: string;
	transport?: FetchTransport;
};

export type ParsedRun = { run: ConfigInput; cli: CliOptions };
type ParsedArgs = ParsedRun | { help: string } | { version: true };

export function flagTakesValue(flag: string): boolean {
	return valueFlags.has(flag);
}

// Single owner of every PipelineConfig invariant: URL normalization/safety,
// default output dir, max + maxExplicit derivation, concurrency range, and the
// perOrigin clamp. Both the CLI and the MCP tools build configs only through
// here, so a new field or rule changes one place.
export function buildPipelineConfig(input: ConfigInput): PipelineConfig {
	let seedUrl: string;
	try {
		seedUrl = parseUrl(input.seedUrl).href;
	} catch {
		throw new Error(`Invalid URL: ${input.seedUrl}`);
	}
	const unsafe = validatePublicHttpUrl(seedUrl);
	if (unsafe) throw new Error(`Unsafe URL: ${unsafe}`);

	const max = input.max ?? 50;
	if (max < 1) throw new Error("--max must be at least 1");
	const concurrency = input.concurrency ?? defaultConcurrency;
	if (concurrency < 1) throw new Error("--concurrency must be at least 1");

	return {
		seedUrl,
		outDir: input.outDir ?? defaultOutDir(seedUrl),
		max,
		maxExplicit: input.maxExplicit ?? input.max !== undefined,
		concurrency,
		perOrigin: Math.min(concurrency, defaultPerOrigin),
		clean: input.clean ?? false,
		dryRun: input.dryRun ?? false,
		agentFiles: input.agentFiles ?? false,
		pageOnly: input.pageOnly ?? false,
		ignoreRobots: input.ignoreRobots ?? false,
		cache: input.cache ?? true,
		userAgent: input.userAgent ?? defaultUserAgent,
		timeoutMs: 10_000,
		maxBytes: 12 * 1024 * 1024,
		...(input.transport ? { transport: input.transport } : {}),
	};
}

// Pure argv -> capture intent translation. It owns only CLI surface concerns:
// help/version sentinels, flag spelling, and per-token value errors. It builds
// no PipelineConfig; buildPipelineConfig consumes the returned ConfigInput.
export function parseArgs(argv: string[]): ParsedArgs {
	if (argv.length === 0 || argv.includes("-h") || argv.includes("--help"))
		return { help: usage };
	if (argv.includes("-v") || argv.includes("--version"))
		return { version: true };

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
		else if (arg === "--no-cache") run.cache = false;
		else if (arg === "--agent-files") run.agentFiles = true;
		else if (arg === "--json") cli.json = true;
		else if (arg === "--quiet") cli.quiet = true;
		else if (arg === "--ignore-robots") run.ignoreRobots = true;
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
	return { run, cli };
}

function readValue(argv: string[], index: number, flag: string) {
	const value = argv[index];
	if (!value || value.startsWith("-"))
		throw new Error(`${flag} requires a value`);
	return value;
}

function defaultOutDir(seedUrl: string) {
	const url = new URL(seedUrl);
	const host = slug(url.hostname.replace(/^www\./, ""));
	const path = url.pathname.split("/").filter(Boolean).slice(0, 2).map(slug);
	return `docsnap/${[host, ...path].filter(Boolean).join("-") || "site"}`;
}

function slug(value: string) {
	return value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
}

function parseUrl(value: string) {
	if (/^https?:\/\//i.test(value)) return new URL(value);
	return new URL(`https://${value}`);
}

function readInt(argv: string[], index: number, flag: string) {
	const value = Number(readValue(argv, index, flag));
	if (!Number.isInteger(value) || value < 1)
		throw new Error(`${flag} requires a positive integer`);
	return value;
}
