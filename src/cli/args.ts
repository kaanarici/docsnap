import { cpus } from "node:os";
import type { Config } from "../core/types.ts";

const defaultConcurrency = Math.min(64, Math.max(16, cpus().length * 6));
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

Flags:
  -o, --out <dir>           output directory, default docsnap/<site>
  -m, --max <count>         max pages; default all llms.txt pages, otherwise 50
  --concurrency <n>         fetch concurrency, default ${defaultConcurrency}
  --clean                   remove output dir before writing
  --dry-run                 run without writing files
  --json                    print one machine-readable result to stdout
  --quiet                   suppress progress logs
  --stdin                   read the URL from stdin
  --ignore-robots           bypass robots.txt rules
  --user-agent <value>      custom User-Agent
  --fail-on-low-quality     exit non-zero when low-quality pages are found
  -v, --version             show version
  -h, --help                show help

Examples:
  docsnap https://docs.trynia.ai -o nia-docs --clean --json
  docsnap https://fly.io/docs/ -m 100 --concurrency 24
  echo https://docs.peel.sh | docsnap --stdin --json --quiet
  docsnap https://example.com --dry-run --json
  docsnap https://example.com --fail-on-low-quality`;

type ParsedArgs = Config | { help: string } | { version: true };

export function flagTakesValue(flag: string): boolean {
	return valueFlags.has(flag);
}

export function parseArgs(argv: string[]): ParsedArgs {
	if (argv.length === 0 || argv.includes("-h") || argv.includes("--help"))
		return { help: usage };
	if (argv.includes("-v") || argv.includes("--version"))
		return { version: true };

	const config: Config = {
		seedUrl: "",
		outDir: "",
		max: 50,
		maxExplicit: false,
		concurrency: defaultConcurrency,
		perOrigin: defaultConcurrency,
		clean: false,
		dryRun: false,
		ignoreRobots: false,
		userAgent:
			"Mozilla/5.0 (compatible; docsnap/0.1; +https://npmjs.com/package/docsnap)",
		timeoutMs: 10_000,
		maxBytes: 8 * 1024 * 1024,
		failOnLowQuality: false,
		json: false,
		quiet: false,
	};
	let outProvided = false;

	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i]!;
		if (!arg.startsWith("-") && !config.seedUrl) {
			config.seedUrl = arg;
			continue;
		}
		if (arg === "-o" || arg === "--out") {
			config.outDir = readValue(argv, ++i, arg);
			outProvided = true;
		} else if (arg === "-m" || arg === "--max") {
			config.max = readInt(argv, ++i, arg);
			config.maxExplicit = true;
		} else if (arg === "--concurrency")
			config.concurrency = readInt(argv, ++i, arg);
		else if (arg === "--clean") config.clean = true;
		else if (arg === "--dry-run") config.dryRun = true;
		else if (arg === "--json") config.json = true;
		else if (arg === "--quiet") config.quiet = true;
		else if (arg === "--ignore-robots") config.ignoreRobots = true;
		else if (arg === "--user-agent")
			config.userAgent = readValue(argv, ++i, arg);
		else if (arg === "--fail-on-low-quality") config.failOnLowQuality = true;
		else throw new Error(`Unknown argument: ${arg}\n\n${usage}`);
	}

	if (!config.seedUrl)
		throw new Error(`Missing URL\n\nTry: docsnap https://example.com --help`);
	try {
		config.seedUrl = parseUrl(config.seedUrl).href;
	} catch {
		throw new Error(`Invalid URL: ${config.seedUrl}`);
	}
	if (!outProvided) config.outDir = defaultOutDir(config.seedUrl);
	if (config.max < 1) throw new Error("--max must be at least 1");
	if (config.concurrency < 1)
		throw new Error("--concurrency must be at least 1");
	config.perOrigin = config.concurrency;
	return config;
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
