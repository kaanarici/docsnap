import { mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "../src/cli/args.ts";
import { runCli } from "../src/cli/index.ts";
import { dedupeRecords } from "../src/core/dedupe.ts";
import { identityKeys } from "../src/core/identity.ts";
import type { PageSuccess } from "../src/core/types.ts";
import { setFetchTransportForTest } from "../src/fetch/fetcher.ts";
import { installAgentFiles } from "../src/output/agent-files.ts";
import { rewriteLocalLinks } from "../src/output/links.ts";
import { renderPage } from "../src/output/page.ts";
import { assignOutputPaths } from "../src/output/paths.ts";
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
// query-addressed pages are distinct content, not path-variant duplicates
const queryAddressed = dedupeRecords([
	page("https://docs.example.com/page?version=1", "html", "v1 body"),
	page("https://docs.example.com/page?version=2", "html", "v2 body"),
]);
assert(queryAddressed.deduped === 0);
assert(queryAddressed.records.length === 2);
// query order does not change identity; ?b=2&a=1 == ?a=1&b=2
const queryOrder = dedupeRecords([
	page("https://docs.example.com/p?a=1&b=2", "html", "first"),
	page("https://docs.example.com/p?b=2&a=1", "markdown", "second"),
]);
assert(queryOrder.deduped === 1);
assert(queryOrder.records.length === 1);
// query-free path variants still merge: regression guard for legacy dedup
assert(
	identityKeys({ url: "https://docs.example.com/page?version=1" })[0] !==
		identityKeys({ url: "https://docs.example.com/page?version=2" })[0],
);
// dedupe must keep transitive aliases and never lose content to a stale key:
// a record accumulates an alias, a better survivor replaces it, then a new best
// record matching the old alias must survive and absorb every alias.
const aliasSeed = {
	...page("https://docs.example.com/a.html", "html", "a body"),
	aliases: ["https://docs.example.com/old-alias.html"],
};
const transitive = dedupeRecords([
	aliasSeed,
	page("https://docs.example.com/a.md", "markdown", "better via route"),
	page(
		"https://docs.example.com/old-alias.html",
		"markdown",
		"best content that must survive the stale alias key ".repeat(40),
	),
]);
assert(transitive.records.length === 1);
const merged = transitive.records[0];
assert(merged?.ok === true);
assert(merged.markdown.startsWith("best content that must survive"));
assert(merged.aliases?.includes("https://docs.example.com/a.html") === true);
assert(merged.aliases?.includes("https://docs.example.com/a.md") === true);
const thinPage = {
	...page("https://docs.example.com/thin", "html", "short"),
	qualityReasons: ["thin content"],
	outputPath: "docs-example-com/thin.md",
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
// an ok record beyond --max is never written (no outputPath): it must not inflate
// lowQuality/qualityWarnings/byExtractor or flip run status for pages not in the corpus
const excessUnwritten = {
	...page("https://docs.example.com/excess", "html", "thin body"),
	confidence: 0.5,
	qualityReasons: ["thin content"],
};
const withExcess = buildSummary(
	[thinPage, excessUnwritten],
	parsedPage,
	2,
	0,
	{ rootHash: "hash", files: 1, bytes: 1 },
	1,
);
assert(withExcess.written === 1);
assert(withExcess.lowQuality === 0);
assert(withExcess.qualityWarnings === 1);
assert(withExcess.byExtractor.html === 1);
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

// local-link rewriting must not mutate captured Markdown examples inside fenced
// code blocks or inline code, must preserve #fragments, and must still rewrite
// real prose links that map to captured pages
const linkRecord = {
	...page("https://docs.example.com/a", "html", ""),
	outputPath: "a.md",
	markdown: [
		"See [Install](https://docs.example.com/b#install) and [Plain](https://docs.example.com/b).",
		"",
		"```md",
		"[Example](https://docs.example.com/b)",
		"```",
		"",
		"Inline `[code](https://docs.example.com/b)` stays.",
	].join("\n"),
};
const rewritten = rewriteLocalLinks(
	linkRecord,
	new Map([["https://docs.example.com/b", "b.md"]]),
);
assert(rewritten.includes("[Install](./b.md#install)"));
assert(rewritten.includes("[Plain](./b.md)"));
assert(rewritten.includes("[Example](https://docs.example.com/b)"));
assert(rewritten.includes("`[code](https://docs.example.com/b)`"));

// a relative internal link to a page NOT in the corpus must be absolutized
// against the page URL so an agent can still follow it; already-absolute
// external links are left verbatim
const danglingRecord = {
	...page("https://docs.example.com/guide/intro", "html", ""),
	outputPath: "guide/intro.md",
	markdown:
		"Relative [Next](../setup/install) and root [API](/api/v2), plus external [GitHub](https://github.com/o/r).",
};
const dangling = rewriteLocalLinks(danglingRecord, new Map());
assert(dangling.includes("[Next](https://docs.example.com/setup/install)"));
assert(dangling.includes("[API](https://docs.example.com/api/v2)"));
assert(dangling.includes("[GitHub](https://github.com/o/r)"));

// long URL path segments must be capped well under the 255-byte filesystem
// component limit while distinct long URLs still map to distinct filenames
const longA = "a".repeat(300);
const longB = `${"a".repeat(299)}b`;
const longRecords: PageSuccess[] = [
	page(`https://x.example.com/${longA}`, "html", "# t"),
	page(`https://x.example.com/${longB}`, "html", "# t"),
];
assignOutputPaths(longRecords);
const longPathA = longRecords[0]?.outputPath ?? "";
const longPathB = longRecords[1]?.outputPath ?? "";
const longSegment = longPathA.split("/").pop() ?? "";
assert(longSegment.length <= 200);
assert(longPathA !== longPathB);

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
