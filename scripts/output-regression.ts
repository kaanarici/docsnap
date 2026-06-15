import { mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "../src/cli/args.ts";
import { runCli } from "../src/cli/index.ts";
import { dedupeRecords } from "../src/core/dedupe.ts";
import { setFetchTransportForTest } from "../src/fetch/fetcher.ts";
import { installAgentFiles } from "../src/output/agent-files.ts";
import { renderPage } from "../src/output/page.ts";
import { agentReadme } from "../src/output/readme.ts";
import { buildSummary } from "../src/report/summary.ts";

const parsedPage = parseArgs(["https://docs.example.com/api/auth", "--page"]);
assert(!("help" in parsedPage) && !("version" in parsedPage));

const duplicate = dedupeRecords([
	page("https://docs.peel.sh/reference/exports", "html", "html body"),
	page(
		"https://docs.peel.sh/reference/exports.md",
		"markdown",
		"markdown body",
	),
]);
assert(duplicate.deduped === 1);
assert(duplicate.records.length === 1);
assert(
	duplicate.records[0]?.ok && duplicate.records[0].markdown === "markdown body",
);
const encodedDuplicate = dedupeRecords([
	page("https://docs.example.com/Web/API/Fetch_API/Using_Fetch", "html", "one"),
	page(
		"https://docs.example.com/Web/API/Fetch%5FAPI/Using%5FFetch",
		"html",
		"two",
	),
]);
assert(encodedDuplicate.deduped === 1);
assert(encodedDuplicate.records.length === 1);
const thinPage = {
	...page("https://docs.example.com/thin", "html", "short"),
	qualityReasons: ["thin content"],
};
const lowQualitySummary = buildSummary(
	[thinPage],
	parsedPage,
	1,
	0,
	{ rootHash: "hash", files: 1, bytes: 1 },
	1,
);
assert(lowQualitySummary.lowQuality === 0);
assert(lowQualitySummary.qualityWarnings === 1);
assert(lowQualitySummary.userAgent === parsedPage.userAgent);
assert(!("ignoreRobots" in lowQualitySummary));
assert(agentReadme([thinPage], lowQualitySummary).includes("thin content"));
// a low-quality page is self-describing: its own frontmatter names the reason
assert(renderPage(thinPage).includes('qualityReasons: ["thin content"]'));
assert(
	!renderPage(
		page("https://docs.example.com/ok", "html", "clean body"),
	).includes("qualityReasons"),
);
const ignoreRobotsSummary = buildSummary(
	[thinPage],
	{ ...parsedPage, ignoreRobots: true },
	1,
	0,
	{ rootHash: "hash", files: 1, bytes: 1 },
	1,
);
assert(ignoreRobotsSummary.ignoreRobots === true);
const dir = await mkdtemp(join(tmpdir(), "docsnap-regression-"));
await writeFile(join(dir, "AGENTS.md"), "# Repo\n");
const agentSummary = {
	...lowQualitySummary,
	outDir: "docsnap/docs-example-com",
	lowQuality: 0,
} satisfies Parameters<typeof installAgentFiles>[0];
const files = await installAgentFiles(agentSummary, dir);
const agentFile = await readFile(join(dir, "AGENTS.md"), "utf8");
assert(files.length === 1 && files[0] === "AGENTS.md");
assert(agentFile.includes("docsnap/docs-example-com/AGENT_README.md"));
const linkedDir = await mkdtemp(join(tmpdir(), "docsnap-agent-link-"));
const outside = join(dir, "outside-agent.md");
await writeFile(outside, "# Outside\n");
await symlink(outside, join(linkedDir, "AGENTS.md"));
const linkedFiles = await installAgentFiles(agentSummary, linkedDir);
assert(linkedFiles.length === 0);
assert((await readFile(outside, "utf8")) === "# Outside\n");
const cli = await captureOutput(async () => {
	setFetchTransportForTest(async (input) => ({
		url: String(input),
		status: 200,
		headers: {
			get: (name: string) => (name === "content-type" ? "text/markdown" : null),
			getSetCookie: () => [],
		},
		body: new TextEncoder().encode(
			"# CLI page\n\nReadable CLI docs captured for JSON summary passthrough.",
		),
	}));
	try {
		await runCli([
			"https://docs.example.com/cli-json",
			"--page",
			"--dry-run",
			"--json",
			"--ignore-robots",
		]);
	} finally {
		setFetchTransportForTest(undefined);
	}
});
const cliJson = JSON.parse(cli.stdout);
assert(cliJson.userAgent === parsedPage.userAgent);
assert(cliJson.ignoreRobots === true);
assert(cli.stderr.includes("--ignore-robots"));

function assert(condition: unknown): asserts condition {
	if (!condition) throw new Error("assertion failed");
}

async function captureOutput(run: () => Promise<void>) {
	const originalStdout = process.stdout.write;
	const originalStderr = process.stderr.write;
	const originalExitCode = process.exitCode;
	let stdout = "";
	let stderr = "";
	process.stdout.write = ((chunk: string | Uint8Array) => {
		stdout += chunk.toString();
		return true;
	}) as typeof process.stdout.write;
	process.stderr.write = ((chunk: string | Uint8Array) => {
		stderr += chunk.toString();
		return true;
	}) as typeof process.stderr.write;
	process.exitCode = undefined;
	try {
		await run();
		return { stdout, stderr, exitCode: process.exitCode };
	} finally {
		process.stdout.write = originalStdout;
		process.stderr.write = originalStderr;
		process.exitCode = originalExitCode;
	}
}

function page(url: string, extractor: "html" | "markdown", markdown: string) {
	return {
		ok: true as const,
		url,
		finalUrl: url,
		redirects: [],
		fetchedAt: "2026-01-01T00:00:00.000Z",
		injectionSignals: [],
		status: 200,
		source: extractor === "markdown" ? ("llms" as const) : ("nav" as const),
		timings: { fetchMs: 1, extractMs: 1, writeMs: 0 },
		markdown,
		links: [],
		contentHash: markdown,
		extractor,
		confidence: 1,
		qualityReasons: [],
	};
}
