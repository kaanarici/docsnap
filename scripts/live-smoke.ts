import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";

type Classification =
	| "clean"
	| "low-quality"
	| "blocked"
	| "app-shell"
	| "timeout"
	| "error"
	| "zero-written";

type Options = { sites: string; max: number };
type Site = { url: string };
type RunError = { url?: string; error?: string; kind?: string };
type RunJson = {
	outDir?: string;
	paths?: Partial<Record<"summary" | "manifest" | "agentReadme", string>>;
	written?: number;
	failed?: number;
	lowQuality?: number;
	qualityWarnings?: number;
	byFailureKind?: Record<string, number | undefined>;
	errors?: RunError[];
};
type ManifestRecord = {
	ok?: boolean;
	outputPath?: string;
	confidence?: number;
	qualityReasons?: unknown[];
};
type Result = Awaited<ReturnType<typeof runSite>>;

const defaultSites = "validation/sites/tier1-smoke.txt";
const defaultMax = 8;
const lowQualityConfidence = 0.6;
const countKeys = [
	"written",
	"failed",
	"lowQuality",
	"qualityWarnings",
] as const;
const blockedPattern = /\b(403|401|429|robots|forbidden|blocked|denied)\b/i;
const appShellPattern =
	/\b(app shell|empty|no readable|no static|client-rendered)\b/i;

try {
	await main();
} catch (error) {
	console.error(errorMessage(error));
	process.exit(1);
}

async function main() {
	const options = parseArgs(process.argv.slice(2));
	const sites = await readSites(options.sites);
	if (sites.length === 0) throw new Error(`No sites found in ${options.sites}`);

	const runRoot = join(".local", `live-smoke-${timestampSlug(new Date())}`);
	const resultsPath = join(runRoot, "results.jsonl");
	await mkdir(runRoot, { recursive: true });

	console.log(`live-smoke root ${runRoot}`);
	console.log(
		"site                               class        pass w    fail low  ms      url",
	);
	console.log("-".repeat(112));

	const results: Result[] = [];
	for (const [index, site] of sites.entries()) {
		const result = await runSite(site, index + 1, options.max, runRoot);
		results.push(result);
		await appendFile(resultsPath, `${JSON.stringify(result)}\n`);
		console.log(tableRow(result));
	}

	const failed = results.filter((result) => !result.passed).length;
	console.log(`results ${resultsPath}`);
	console.log(
		failed === 0
			? `${results.length}/${results.length} passed`
			: `${failed}/${results.length} failed pass criteria`,
	);
	if (failed > 0) process.exitCode = 1;
}

async function runSite(
	site: Site,
	index: number,
	max: number,
	runRoot: string,
) {
	const id = siteId(site.url, index);
	const outDir = join(runRoot, id);
	const command = [
		"bun",
		"bin/docsnap",
		site.url,
		"-m",
		String(max),
		"-o",
		outDir,
		"--clean",
		"--json",
		"--quiet",
	];
	const started = performance.now();
	const processResult = await spawn(command);
	const durationMs = Math.round(performance.now() - started);
	const parsed = parseCliJson(processResult.stdout);
	const artifacts = parsed.value
		? await verifyArtifacts(parsed.value, outDir)
		: undefined;
	const summary = artifacts?.summary ?? parsed.value;
	const written = numeric(summary?.written);
	const parserErrors = parserErrorsFrom(summary);
	const artifactIssues = [
		...(parsed.error ? [`cli json: ${parsed.error}`] : []),
		...(artifacts?.issues ?? []),
		...(processResult.exitCode !== 0 && written > 0
			? [
					`docsnap exited ${processResult.exitCode} after writing ${written} pages`,
				]
			: []),
	];
	const byFailureKind = summary?.byFailureKind ?? {};
	const failed = numeric(summary?.failed);
	const lowQuality = numeric(summary?.lowQuality);
	const qualityWarnings = numeric(summary?.qualityWarnings);
	const counts = {
		written,
		failed,
		lowQuality,
		qualityWarnings,
	};
	const classification = classify({
		artifactIssues,
		parserErrors,
		...counts,
		byFailureKind,
		errors: summary?.errors ?? [],
	});
	const passed =
		processResult.exitCode === 0 &&
		written > 0 &&
		parserErrors.length === 0 &&
		artifactIssues.length === 0;

	return {
		site: id,
		url: site.url,
		outDir,
		exitCode: processResult.exitCode,
		durationMs,
		classification,
		passed,
		counts,
		byFailureKind,
		parserErrors,
		artifactIssues,
		...(processResult.stderr.trim()
			? { stderr: clip(processResult.stderr.trim(), 2000) }
			: {}),
		...(parsed.value
			? {}
			: { stdout: clip(processResult.stdout.trim(), 2000) }),
	};
}

async function spawn(command: string[]) {
	const subprocess = Bun.spawn({
		cmd: command,
		cwd: process.cwd(),
		stdout: "pipe",
		stderr: "pipe",
	});
	const [exitCode, stdout, stderr] = await Promise.all([
		subprocess.exited,
		new Response(subprocess.stdout).text(),
		new Response(subprocess.stderr).text(),
	]);
	return { exitCode, stdout, stderr };
}

async function verifyArtifacts(json: RunJson, outDir: string) {
	const paths = {
		summary: json.paths?.summary ?? join(outDir, "summary.json"),
		manifest: json.paths?.manifest ?? join(outDir, "manifest.jsonl"),
		agentReadme: json.paths?.agentReadme ?? join(outDir, "AGENT_README.md"),
	};
	const issues: string[] = [];
	const [summaryText, manifestText, readmeText] = await Promise.all([
		readArtifact(paths.summary, "summary.json", issues),
		readArtifact(paths.manifest, "manifest.jsonl", issues),
		readArtifact(paths.agentReadme, "AGENT_README.md", issues),
	]);
	if (readmeText !== undefined && readmeText.trim().length === 0) {
		issues.push("AGENT_README.md is empty");
	}
	const summary = summaryText
		? parseJsonObject<RunJson>(summaryText, "summary.json", issues)
		: undefined;
	const manifest = manifestText
		? parseManifest(manifestText, "manifest.jsonl", issues)
		: undefined;
	if (summary) {
		for (const key of countKeys) {
			const left = json[key];
			const right = summary[key];
			if (
				typeof left === "number" &&
				typeof right === "number" &&
				left !== right
			) {
				issues.push(`cli ${key}=${left} but summary ${key}=${right}`);
			}
		}
	}
	if (summary && manifest) compareManifest(summary, manifest, issues);
	return { issues, ...(summary ? { summary } : {}) };
}

async function readArtifact(path: string, label: string, issues: string[]) {
	try {
		return await readFile(path, "utf8");
	} catch (error) {
		issues.push(`${label} missing at ${path}: ${errorMessage(error)}`);
		return undefined;
	}
}

function compareManifest(
	summary: RunJson,
	manifest: ManifestRecord[],
	issues: string[],
) {
	const stats = { written: 0, failed: 0, lowQuality: 0, qualityWarnings: 0 };
	for (const record of manifest) {
		if (record.ok === false) stats.failed++;
		if (record.ok !== true) continue;
		if (record.outputPath) stats.written++;
		if (
			typeof record.confidence === "number" &&
			record.confidence < lowQualityConfidence
		) {
			stats.lowQuality++;
		} else if (
			typeof record.confidence === "number" &&
			Array.isArray(record.qualityReasons) &&
			record.qualityReasons.length > 0
		) {
			stats.qualityWarnings++;
		}
	}
	for (const key of countKeys) {
		if (typeof summary[key] === "number" && stats[key] !== summary[key]) {
			issues.push(`manifest ${key}=${stats[key]} but summary=${summary[key]}`);
		}
	}
}

function parseCliJson(stdout: string): { value?: RunJson; error?: string } {
	const lines = stdout.trim().split(/\r?\n/).filter(Boolean);
	const last = lines[lines.length - 1];
	if (!last) return { error: "stdout was empty" };
	try {
		const parsed = JSON.parse(last);
		return isObject(parsed)
			? { value: parsed as RunJson }
			: { error: "JSON result was not an object" };
	} catch (error) {
		return { error: errorMessage(error) };
	}
}

function parseJsonObject<T>(text: string, label: string, issues: string[]) {
	try {
		const parsed = JSON.parse(text);
		if (isObject(parsed)) return parsed as T;
		issues.push(`${label} was not a JSON object`);
		return undefined;
	} catch (error) {
		issues.push(`${label} JSON parse failed: ${errorMessage(error)}`);
		return undefined;
	}
}

function parseManifest(text: string, label: string, issues: string[]) {
	const records: ManifestRecord[] = [];
	for (const [index, line] of text
		.trim()
		.split(/\r?\n/)
		.filter(Boolean)
		.entries()) {
		try {
			const parsed = JSON.parse(line);
			if (isObject(parsed)) records.push(parsed as ManifestRecord);
			else issues.push(`${label}:${index + 1} was not an object`);
		} catch (error) {
			issues.push(`${label}:${index + 1} parse failed: ${errorMessage(error)}`);
		}
	}
	return records;
}

function parserErrorsFrom(summary: RunJson | undefined) {
	return (summary?.errors ?? [])
		.filter(
			(error) =>
				error.kind === "extract" ||
				/\b(parse|parser|syntax|defuddle)\b/i.test(error.error ?? ""),
		)
		.map((error) =>
			`${error.kind ?? "error"} ${error.url ?? ""} ${error.error ?? ""}`.trim(),
		);
}

function classify(input: {
	artifactIssues: string[];
	parserErrors: string[];
	written: number;
	lowQuality: number;
	qualityWarnings: number;
	byFailureKind: Record<string, number | undefined>;
	errors: RunError[];
}): Classification {
	if (input.artifactIssues.length > 0 || input.parserErrors.length > 0) {
		return "error";
	}
	if (hasKind(input, "timeout", /\btimeout\b/i)) return "timeout";
	if (hasKind(input, "blocked", blockedPattern)) return "blocked";
	if (hasKind(input, "empty", appShellPattern)) return "app-shell";
	if (input.written === 0) return "zero-written";
	if (input.lowQuality > 0 || input.qualityWarnings > 0) return "low-quality";
	return "clean";
}

function hasKind(
	input: {
		byFailureKind: Record<string, number | undefined>;
		errors: RunError[];
	},
	kind: string,
	pattern: RegExp,
) {
	return (
		numeric(input.byFailureKind[kind]) > 0 ||
		input.errors.some(
			(error) => error.kind === kind || pattern.test(error.error ?? ""),
		)
	);
}

async function readSites(path: string) {
	const sites: Site[] = [];
	const text = await readFile(path, "utf8");
	for (const [index, raw] of text.split(/\r?\n/).entries()) {
		const trimmed = raw.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;
		const commentAt = raw.indexOf("#");
		const urlText =
			commentAt >= 0 ? raw.slice(0, commentAt).trim() : raw.trim();
		try {
			const url = new URL(
				/^https?:\/\//i.test(urlText) ? urlText : `https://${urlText}`,
			);
			sites.push({ url: url.href });
		} catch {
			throw new Error(`${path}:${index + 1} is not a valid URL: ${urlText}`);
		}
	}
	return sites;
}

function parseArgs(argv: string[]): Options {
	const options = { sites: defaultSites, max: defaultMax };
	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index]!;
		if (arg === "-h" || arg === "--help") {
			console.log(
				`Usage: bun scripts/live-smoke.ts [--sites ${defaultSites}] [--max ${defaultMax}]`,
			);
			process.exit(0);
		}
		if (arg === "--sites") options.sites = readArgValue(argv, ++index, arg);
		else if (arg.startsWith("--sites=")) {
			options.sites = arg.slice("--sites=".length);
		} else if (arg === "--max") {
			options.max = readPositiveInt(readArgValue(argv, ++index, arg), arg);
		} else if (arg.startsWith("--max=")) {
			options.max = readPositiveInt(arg.slice("--max=".length), "--max");
		} else throw new Error(`Unknown argument: ${arg}`);
	}
	return options;
}

function readArgValue(argv: string[], index: number, flag: string) {
	const value = argv[index];
	if (!value || value.startsWith("-"))
		throw new Error(`${flag} requires a value`);
	return value;
}

function readPositiveInt(value: string, flag: string) {
	const parsed = Number(value);
	if (!Number.isInteger(parsed) || parsed < 1) {
		throw new Error(`${flag} requires a positive integer`);
	}
	return parsed;
}

function siteId(rawUrl: string, index: number) {
	const url = new URL(rawUrl);
	const parts = [
		url.hostname.replace(/^www\./, ""),
		...url.pathname.split("/").filter(Boolean).slice(0, 2),
	];
	return `${String(index).padStart(2, "0")}-${slug(parts.join("-") || "site")}`;
}

function tableRow(result: Result) {
	return [
		pad(clip(result.site, 34), 34),
		pad(result.classification, 12),
		pad(result.passed ? "yes" : "no", 4),
		pad(String(result.counts.written), 4),
		pad(String(result.counts.failed), 4),
		pad(String(result.counts.lowQuality), 4),
		pad(String(result.durationMs), 7),
		result.url,
	].join(" ");
}

function slug(value: string) {
	return value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 72);
}

function isObject(value: unknown) {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function pad(value: string, width: number) {
	return value.length >= width
		? value
		: `${value}${" ".repeat(width - value.length)}`;
}

function timestampSlug(date: Date) {
	return date.toISOString().replace(/[:.]/g, "-");
}

function numeric(value: unknown) {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function errorMessage(error: unknown) {
	return error instanceof Error ? error.message : String(error);
}

function clip(value: string, max: number) {
	return value.length <= max ? value : `${value.slice(0, max - 3)}...`;
}
