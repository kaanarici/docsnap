import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPipelineConfig, parseArgs } from "../src/cli/args.ts";
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

const parsedPageArgs = parseArgs([
	"https://docs.example.com/api/auth",
	"--page",
]);
if ("help" in parsedPageArgs || "version" in parsedPageArgs) {
	throw new Error("parseArgs returned help/version");
}
const parsedPage = buildPipelineConfig(parsedPageArgs.run);

function expectOkRecord<T extends { ok: boolean }>(
	record: T | undefined,
): Extract<T, { ok: true }> {
	expect(record?.ok).toBe(true);
	if (!record?.ok) throw new Error("expected ok record");
	return record as Extract<T, { ok: true }>;
}

describe("record deduplication", () => {
	test("prefers markdown over matching html route variants", () => {
		const duplicate = dedupeRecords([
			page("https://docs.peel.sh/reference/exports", "html", "html body"),
			page(
				"https://docs.peel.sh/reference/exports.md",
				"markdown",
				"markdown body",
			),
		]);
		expect(duplicate.deduped).toBe(1);
		expect(duplicate.records).toHaveLength(1);
		expect(expectOkRecord(duplicate.records[0]).markdown).toBe("markdown body");
	});

	test("encoded path variants merge into one record", () => {
		const encodedDuplicate = dedupeRecords([
			page(
				"https://docs.example.com/Web/API/Fetch_API/Using_Fetch",
				"html",
				"one",
			),
			page(
				"https://docs.example.com/Web/API/Fetch%5FAPI/Using%5FFetch",
				"html",
				"two",
			),
		]);
		expect(encodedDuplicate.deduped).toBe(1);
		expect(encodedDuplicate.records).toHaveLength(1);
	});

	test("query-addressed pages remain distinct content", () => {
		const queryAddressed = dedupeRecords([
			page("https://docs.example.com/page?version=1", "html", "v1 body"),
			page("https://docs.example.com/page?version=2", "html", "v2 body"),
		]);
		expect(queryAddressed.deduped).toBe(0);
		expect(queryAddressed.records).toHaveLength(2);
		expect(
			identityKeys({ url: "https://docs.example.com/page?version=1" })[0],
		).not.toBe(
			identityKeys({ url: "https://docs.example.com/page?version=2" })[0],
		);
	});

	test("query order does not change identity", () => {
		const queryOrder = dedupeRecords([
			page("https://docs.example.com/p?a=1&b=2", "html", "first"),
			page("https://docs.example.com/p?b=2&a=1", "markdown", "second"),
		]);
		expect(queryOrder.deduped).toBe(1);
		expect(queryOrder.records).toHaveLength(1);
	});

	test("keeps transitive aliases and does not lose content to stale keys", () => {
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
		expect(transitive.records).toHaveLength(1);
		const merged = expectOkRecord(transitive.records[0]);
		expect(merged.markdown.startsWith("best content that must survive")).toBe(
			true,
		);
		expect(merged.aliases?.includes("https://docs.example.com/a.html")).toBe(
			true,
		);
		expect(merged.aliases?.includes("https://docs.example.com/a.md")).toBe(
			true,
		);
	});
});

describe("summary quality accounting", () => {
	test("counts low-quality warnings for written pages without exposing robots defaults", () => {
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
		expect(lowQualitySummary.lowQuality).toBe(0);
		expect(lowQualitySummary.qualityWarnings).toBe(1);
		expect(lowQualitySummary.userAgent).toBe(parsedPage.userAgent);
		expect(lowQualitySummary).not.toHaveProperty("ignoreRobots");
	});

	test("ignores low-quality unwritten ok records beyond max", () => {
		const thinPage = {
			...page("https://docs.example.com/thin", "html", "short"),
			qualityReasons: ["thin content"],
			outputPath: "docs-example-com/thin.md",
		};
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
		expect(withExcess.written).toBe(1);
		expect(withExcess.lowQuality).toBe(0);
		expect(withExcess.qualityWarnings).toBe(1);
		expect(withExcess.byExtractor.html).toBe(1);
	});

	test("surfaces ignoreRobots only when requested", () => {
		const thinPage = {
			...page("https://docs.example.com/thin", "html", "short"),
			qualityReasons: ["thin content"],
			outputPath: "docs-example-com/thin.md",
		};
		const ignoreRobotsSummary = buildSummary(
			[thinPage],
			{ ...parsedPage, ignoreRobots: true },
			1,
			0,
			{ rootHash: "hash", files: 1, bytes: 1 },
			1,
		);
		expect(ignoreRobotsSummary.ignoreRobots).toBe(true);
	});
});

describe("rendered page metadata", () => {
	test("names low-quality reasons in frontmatter only when present", () => {
		const thinPage = {
			...page("https://docs.example.com/thin", "html", "short"),
			qualityReasons: ["thin content"],
			outputPath: "docs-example-com/thin.md",
		};
		expect(renderPage(thinPage)).toContain("thin content");
		expect(
			renderPage(page("https://docs.example.com/ok", "html", "clean body")),
		).not.toContain("qualityReasons");
	});
});

describe("agent navigation files", () => {
	test("updates an existing AGENTS.md with a docsnap pointer", async () => {
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
		const dir = await mkdtemp(join(tmpdir(), "docsnap-regression-"));
		await writeFile(join(dir, "AGENTS.md"), "# Repo\n");
		const agentSummary = {
			...lowQualitySummary,
			outDir: "docsnap/docs-example-com",
			lowQuality: 0,
		} satisfies Parameters<typeof installAgentFiles>[0];
		const files = await installAgentFiles(agentSummary, dir);
		const agentFile = await readFile(join(dir, "AGENTS.md"), "utf8");
		expect(files.length === 1 && files[0] === "AGENTS.md").toBe(true);
		expect(agentFile).toContain("docsnap/docs-example-com/AGENT_README.md");
	});

	test("does not follow a symlinked AGENTS.md outside the output dir", async () => {
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
		const dir = await mkdtemp(join(tmpdir(), "docsnap-regression-"));
		const agentSummary = {
			...lowQualitySummary,
			outDir: "docsnap/docs-example-com",
			lowQuality: 0,
		} satisfies Parameters<typeof installAgentFiles>[0];
		const linkedDir = await mkdtemp(join(tmpdir(), "docsnap-agent-link-"));
		const outside = join(dir, "outside-agent.md");
		await writeFile(outside, "# Outside\n");
		await symlink(outside, join(linkedDir, "AGENTS.md"));
		const linkedFiles = await installAgentFiles(agentSummary, linkedDir);
		expect(linkedFiles).toHaveLength(0);
		expect(await readFile(outside, "utf8")).toBe("# Outside\n");
	});
});

describe("CLI JSON output", () => {
	test("passes ignore-robots through JSON and stderr", async () => {
		const cli = await captureOutput(async () => {
			setFetchTransportForTest(async (input) => ({
				url: String(input),
				status: 200,
				headers: {
					get: (name: string) =>
						name === "content-type" ? "text/markdown" : null,
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
		expect(cliJson.userAgent).toBe(parsedPage.userAgent);
		expect(cliJson.ignoreRobots).toBe(true);
		expect(cli.stderr).toContain("--ignore-robots");
	});
});

describe("local link rewriting", () => {
	test("rewrites prose links without mutating code examples", () => {
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
		expect(rewritten).toContain("[Install](./b.md#install)");
		expect(rewritten).toContain("[Plain](./b.md)");
		expect(rewritten).toContain("[Example](https://docs.example.com/b)");
		expect(rewritten).toContain("`[code](https://docs.example.com/b)`");
	});

	test("absolutizes uncaptured relative internal links", () => {
		const danglingRecord = {
			...page("https://docs.example.com/guide/intro", "html", ""),
			outputPath: "guide/intro.md",
			markdown:
				"Relative [Next](../setup/install) and root [API](/api/v2), plus external [GitHub](https://github.com/o/r).",
		};
		const dangling = rewriteLocalLinks(danglingRecord, new Map());
		expect(dangling).toContain(
			"[Next](https://docs.example.com/setup/install)",
		);
		expect(dangling).toContain("[API](https://docs.example.com/api/v2)");
		expect(dangling).toContain("[GitHub](https://github.com/o/r)");
	});
});

describe("output path assignment", () => {
	test("caps long URL segments while keeping distinct filenames", () => {
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
		expect(longSegment.length).toBeLessThanOrEqual(200);
		expect(longPathA).not.toBe(longPathB);
	});
});

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
