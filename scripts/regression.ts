import { type FetchedUrl, lowQualityConfidence } from "../src/core/types.ts";
import { parseRobots } from "../src/discover/robots.ts";
import { ignoredExtension } from "../src/discover/url.ts";
import { extractPage } from "../src/extract/html.ts";

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

function assert(
	condition: unknown,
	message = "assertion failed",
): asserts condition {
	if (!condition) throw new Error(message);
}
