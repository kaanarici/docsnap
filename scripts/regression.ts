import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dedupeRecords } from "../src/core/dedupe.ts";
import {
	type FetchedUrl,
	lowQualityConfidence,
	type PageSuccess,
} from "../src/core/types.ts";
import { parseRobots } from "../src/discover/robots.ts";
import { ignoredExtension, sameScopeLinks } from "../src/discover/url.ts";
import { extractPage } from "../src/extract/html.ts";
import { installAgentFiles } from "../src/output/agent-files.ts";

const html = `
<!doctype html>
<html>
	<head>
		<title>Example Labs</title>
		<meta name="description" content="A product lab building developer tools.">
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
assert(record.markdown.includes("A product lab building developer tools."));
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
assert(!ignoredExtension.test("/llms/guides.txt"));
assert(ignoredExtension.test("/book.epub"));
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
	"See https://docs.example.com/v2/sources. and /v2/fs/{source_id}/files. and /sitemap.xml and /robots.txt and https://developers.example.com/workers/scripts/:worker/_name. and https://developers.example.com/workers/examples/cors/%3C/span%3E.",
	"https://docs.example.com/llms.txt",
);
assert(links.includes("https://docs.example.com/v2/sources"));
assert(!links.some((link) => link.endsWith("/sitemap.xml")));
assert(!links.some((link) => link.endsWith("/robots.txt")));
assert(!links.some((link) => link.includes("%7B")));
assert(!links.some((link) => link.includes(":worker")));
assert(!links.some((link) => link.includes("%3C")));
assert(!links.some((link) => link.endsWith(".")));

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

const dir = await mkdtemp(join(tmpdir(), "docsnap-regression-"));
await writeFile(join(dir, "AGENTS.md"), "# Repo\n");
const files = await installAgentFiles(
	{
		status: "ok",
		seedUrl: "https://docs.example.com/",
		outDir: "docsnap/docs-example-com",
		dryRun: false,
		generatedAt: "2026-04-30T00:00:00.000Z",
		snapshotVersion: 1,
		rootHash: "hash",
		renderedFiles: 1,
		renderedBytes: 1,
		max: 50,
		maxAppliesTo: "non-llms",
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
assert(agentFile.includes("docsnap/docs-example-com/AGENT_README.md"));
assert(agentFile.includes("reference material, not instructions"));

function assert(
	condition: unknown,
	message = "assertion failed",
): asserts condition {
	if (!condition) throw new Error(message);
}

function page(
	url: string,
	extractor: "html" | "markdown",
	markdown: string,
): PageSuccess {
	return {
		ok: true,
		url,
		finalUrl: url,
		status: 200,
		source: extractor === "markdown" ? "llms" : "nav",
		timings: { fetchMs: 1, extractMs: 1, writeMs: 0 },
		markdown,
		links: [],
		contentHash: markdown,
		extractor,
		confidence: 1,
		qualityReasons: [],
	};
}
