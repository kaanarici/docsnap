import { expect, test } from "bun:test";
import { extractPage } from "../src/extract/html.ts";
import { okFetch } from "./fixtures.ts";

test("classifies markdown and text assets onto dedicated plans", async () => {
	const [markdown, , markdownShell] = await extractSeed(
		"https://docs.example.com/guide.md",
		"# Guide\n\nHash-verified documentation content for local search.",
		{ contentType: "text/markdown" },
	);
	expect(markdown).toMatchObject({
		ok: true,
		kind: "markdown",
		extractor: "markdown",
	});
	expect(markdownShell).toBe(false);

	const [json, , jsonShell] = await extractSeed(
		"https://docs.example.com/config.json",
		'{"name":"docsnap"}',
		{ contentType: "application/json" },
	);
	expect(json).toMatchObject({
		ok: true,
		kind: "markdown",
		extractor: "text",
	});
	expect(jsonShell).toBe(false);
	if (!json.ok) throw new Error("json extract failed");
	expect(json.confidence).toBeGreaterThan(0);
});

test("fails feed, empty, and blocked pages before HTML extract", async () => {
	const [feed, , feedShell] = await extractSeed(
		"https://docs.example.com/feed.xml",
		`<?xml version="1.0"?><rss version="2.0"><channel><title>Docs</title></channel></rss>`,
		{ contentType: "application/rss+xml" },
	);
	expect(feed).toMatchObject({
		ok: false,
		failureKind: "empty",
		error: "feed resource used for discovery, not a content page",
	});
	expect(feedShell).toBe(false);

	const [language, , languageShell] = await extractSeed(
		"https://docs.example.com/select-language",
		`<html><body class="path-select-language ecl-splash-page__language"></body></html>`,
	);
	expect(language).toMatchObject({
		ok: false,
		failureKind: "empty",
		error: "language selector without article content",
	});
	expect(languageShell).toBe(false);

	const [blocked, , blockedShell] = await extractSeed(
		"https://docs.example.com/login",
		`<html><head><title>Sign in</title></head><body><h1>Sign in</h1><p>Please sign in to continue.</p><form><input type="email"><input type="password"></form></body></html>`,
	);
	expect(blocked).toMatchObject({ ok: false, failureKind: "blocked" });
	expect(blockedShell).toBe(false);
});

test("skips Defuddle for app shells and recovers inline state only", async () => {
	const [empty, , emptyShell] = await extractSeed(
		"https://docs.example.com/app",
		`<html><head><title>Docs</title></head><body><div id="__next"></div><script src="/app.js"></script></body></html>`,
	);
	expect(empty).toMatchObject({ ok: false, failureKind: "empty" });
	expect(emptyShell).toBe(true);

	const paragraphs = [
		"Install the command line package and configure the project before capturing your first documentation site.",
		"The capture command follows public links, records failures, and writes clean Markdown files with source metadata.",
		"Review the generated summary and manifest to verify page counts, redirects, content hashes, and quality warnings.",
	];
	const payload = paragraphs.map((text) => JSON.stringify(text)).join(",");
	const [inline, , inlineShell] = await extractSeed(
		"https://docs.example.com/guide",
		`<html><head><title>Docs</title></head><body><div id="__next"></div><script>self.__next_f.push([1,${JSON.stringify(payload)}])</script></body></html>`,
	);
	expect(inline).toMatchObject({
		ok: true,
		kind: "app-shell",
		extractor: "inline-state",
		inlineStateSource: "rsc",
	});
	expect(inlineShell).toBe(true);
	if (!inline.ok) throw new Error("inline-state extract failed");
	expect(inline.markdown).toContain("Install the command line package");
	expect(inline.confidence).toBeGreaterThan(0);
});

test("runs structured-only extract for docs HTML", async () => {
	const [record, , shell] = await extractSeed(
		"https://docs.example.com/cli",
		`<html><head><title>CLI</title><meta name="generator" content="Docusaurus"></head><body><div id="__docusaurus"><nav>${"abcdefghijklmnopqrstuvwxyz"
			.split("")
			.map((letter) => `<a href="/${letter}">${letter}</a>`)
			.join(
				"",
			)}</nav><main><h1>CLI</h1><h2>Install</h2><pre>bun add -g docsnap</pre><p>Run the capture command against a public documentation site and write local Markdown files.</p><h2>Search</h2><p>Rank local hits with source URLs, titles, and the recorded confidence for each captured page.</p></main></div></body></html>`,
	);
	expect(record).toMatchObject({
		ok: true,
		kind: "docs-html",
		extractor: "structured",
	});
	expect(shell).toBe(false);
	if (!record.ok) throw new Error("docs extract failed");
	expect(record.markdown).toContain("CLI");
	expect(record.confidence).toBeGreaterThan(0);
});

test("runs Defuddle once for article HTML without swapping console", async () => {
	const error = console.error;
	const warn = console.warn;
	const [record, , shell] = await extractSeed(
		"https://blog.example.com/hashing",
		`<html><head><title>Why hashing matters</title></head><body><article><h1>Why hashing matters</h1><p>Hash-verified documentation lets agents trust a local corpus after a capture run. Each page records a content hash so later refreshes can detect drift without rereading every file.</p><p>When a page changes, the writer replaces that Markdown file and updates the manifest. Unchanged pages keep their previous output path, title, and hash so search ranking stays stable.</p></article></body></html>`,
	);
	expect(console.error).toBe(error);
	expect(console.warn).toBe(warn);
	expect(record).toMatchObject({
		ok: true,
		kind: "article-html",
		extractor: "html",
	});
	expect(shell).toBe(false);
	if (!record.ok) throw new Error("article extract failed");
	expect(record.markdown).toContain("Hash-verified documentation");
	expect(record.confidence).toBeGreaterThan(0);
});

test("keeps Defuddle article text when chrome-only recovery is thin", async () => {
	const [record, , shell] = await extractSeed(
		"https://docs.example.com/docs/hub",
		`<main><h1>Hub</h1><p>Hub documentation.</p><a href="/docs/a">A</a><a href="/docs/b">B</a></main>`,
	);
	expect(record).toMatchObject({
		ok: true,
		kind: "article-html",
		extractor: "html",
	});
	expect(shell).toBe(false);
	if (!record.ok) throw new Error("hub extract failed");
	expect(record.markdown).toContain("Hub documentation");
});

function extractSeed(
	url: string,
	body: string,
	overrides?: Parameters<typeof okFetch>[2],
) {
	return extractPage({
		source: "seed",
		wasSeed: true,
		result: okFetch(url, body, overrides),
	});
}
