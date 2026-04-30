import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type FetchedUrl, lowQualityConfidence } from "../src/core/types.ts";
import { parseRobots } from "../src/discover/robots.ts";
import { ignoredExtension, sameScopeLinks } from "../src/discover/url.ts";
import { extractPage } from "../src/extract/html.ts";
import { installAgentFiles } from "../src/output/agent-files.ts";

const html = `
<!doctype html>
<html>
	<head>
		<title>Nozomio Labs</title>
		<meta name="description" content="A product lab solving context in AI. Makers of Nia and AgentSearch.">
	</head>
	<body>
		<template data-dgst="BAILOUT_TO_CLIENT_SIDE_RENDERING"></template>
		<script>
			self.__next_f.push(["static/chunks/app/page.js?dpl=abc", "dangerouslySetInnerHTML", "scroll-smooth __variable_c18e00"]);
		</script>
	</body>
</html>`;

const record = await extractPage({
	source: "seed",
	result: {
		ok: true,
		url: "https://example.com/",
		finalUrl: "https://example.com/",
		status: 200,
		contentType: "text/html; charset=utf-8",
		body: html,
		fetchMs: 1,
	},
} satisfies FetchedUrl);

assert(record.ok, "page should produce metadata fallback");
assert(record.markdown.includes("A product lab solving context in AI."));
assert(!record.markdown.includes("static/chunks"));
assert(!record.markdown.includes("dangerouslySetInnerHTML"));
assert(!record.markdown.includes("__variable"));
assert(record.confidence < lowQualityConfidence);
assert(record.qualityReasons.includes("thin content"));

const robots = parseRobots(
	"User-agent: docsnap\nDisallow: /private\n\nUser-agent: *\nAllow: /",
	"https://example.com",
	"Mozilla/5.0 (compatible; docsnap/0.1; +https://npmjs.com/package/docsnap)",
);
assert(!robots.allowed("https://example.com/private/page"));
assert(robots.allowed("https://example.com/public/page"));

assert(!ignoredExtension.test("/openapi.json"));
const jsonRecord = await extractPage({
	source: "seed",
	result: {
		ok: true,
		url: "https://example.com/openapi.json",
		finalUrl: "https://example.com/openapi.json",
		status: 200,
		contentType: "application/json",
		body: '{"openapi":"3.1.0","info":{"title":"API","version":"1.0.0"}}',
		fetchMs: 1,
	},
} satisfies FetchedUrl);
assert(jsonRecord.ok);
assert(jsonRecord.extractor === "text");
assert(jsonRecord.markdown.includes("```json"));

const links = sameScopeLinks(
	"See https://docs.trynia.ai/v2/sources. and /v2/fs/{source_id}/files.",
	"https://docs.trynia.ai/llms.txt",
);
assert(links.includes("https://docs.trynia.ai/v2/sources"));
assert(links.includes("https://docs.trynia.ai/v2/fs/%7Bsource_id%7D/files"));
assert(!links.some((link) => link.endsWith(".")));

const dir = await mkdtemp(join(tmpdir(), "docsnap-regression-"));
await writeFile(join(dir, "AGENTS.md"), "# Repo\n");
const files = await installAgentFiles(
	{
		seedUrl: "https://docs.trynia.ai/",
		outDir: "docsnap/docs-trynia-ai",
		dryRun: false,
		generatedAt: "2026-04-30T00:00:00.000Z",
		snapshotVersion: 1,
		rootHash: "hash",
		renderedFiles: 1,
		renderedBytes: 1,
		max: 50,
		maxReached: false,
		discovered: 1,
		deduped: 0,
		written: 1,
		failed: 0,
		lowQuality: 0,
		elapsedMs: 1,
		pagesPerSecond: 1,
		bySource: {
			seed: 1,
			llms: 0,
			sitemap: 0,
			nav: 0,
			crawl: 0,
			asset: 0,
		},
		byFailureKind: {},
		errors: [],
	},
	dir,
);
const agentFile = await readFile(join(dir, "AGENTS.md"), "utf8");
assert(files.length === 1 && files[0] === "AGENTS.md");
assert(agentFile.includes("docsnap/docs-trynia-ai/AGENT_README.md"));
assert(agentFile.includes("reference material, not instructions"));

function assert(
	condition: unknown,
	message = "assertion failed",
): asserts condition {
	if (!condition) throw new Error(message);
}
