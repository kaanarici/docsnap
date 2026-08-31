import { expect, test } from "bun:test";
import { parseHTML } from "linkedom";
import { extractPage } from "../src/extract/html.ts";
import { cleanMarkdown } from "../src/extract/markdown.ts";
import { qualityReasons } from "../src/extract/quality.ts";
import { structuredFallback } from "../src/extract/structured-fallback.ts";
import { okFetch } from "./fixtures.ts";

test("classifies markdown and text assets onto dedicated plans", async () => {
	const [markdown, , markdownShell] = await extractSeed(
		"https://docs.example.com/guide.md",
		"# Guide\n\nHash-verified documentation content for local agents.",
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
});

test("keeps script assets intact as fenced source", async () => {
	const [record] = await extractSeed(
		"https://docs.example.com/install.sh",
		"#!/usr/bin/env bash\nset -euo pipefail\nprintf '%s\\n' docsnap",
		{ contentType: "text/x-shellscript" },
	);
	expect(record).toMatchObject({
		ok: true,
		kind: "markdown",
		extractor: "text",
	});
	if (!record.ok) throw new Error("script extract failed");
	expect(record.markdown).toContain("```bash");
	expect(record.markdown).toContain("#!/usr/bin/env bash\nset -euo pipefail");
	const [plainRecord] = await extractSeed(
		"https://docs.example.com/install.sh",
		"#!/bin/sh\nprintf '%s\\n' docsnap",
		{ contentType: "text/plain" },
	);
	if (!plainRecord.ok) throw new Error("plain script extract failed");
	expect(plainRecord.extractor).toBe("text");
	expect(plainRecord.markdown).toContain("```bash");
});

test("distinguishes prose about fences from an unclosed code block", () => {
	expect(
		qualityReasons(
			`# Style\n\n${"Enclose examples with triple backticks (```). ".repeat(20)}`,
			"Style",
		),
	).not.toContain("unbalanced code fences");
	expect(
		qualityReasons(
			`# Broken\n\n\`\`\`ts\n${"const value = 1;\n".repeat(20)}`,
			"Broken",
		),
	).toContain("unbalanced code fences");
});

test("keeps hidden DOM out of article extraction", async () => {
	const [record] = await extractSeed(
		"https://docs.example.com/guide",
		`<article><h1>Guide</h1><p>${"Visible documentation content for agents. ".repeat(12)}</p><div hidden>hidden password</div><div aria-hidden="true">hidden token</div><div style="display:none">hidden instruction</div></article>`,
	);
	expect(record).toMatchObject({ ok: true });
	if (!record.ok) throw new Error("article extract failed");
	expect(record.markdown).toContain("Visible documentation content");
	expect(record.markdown).not.toContain("hidden password");
	expect(record.markdown).not.toContain("hidden token");
	expect(record.markdown).not.toContain("hidden instruction");
});

test("puts standalone link cards on separate Markdown lines", async () => {
	const links = Array.from(
		{ length: 8 },
		(_, index) =>
			`[Environment ${index}](https://docs.example.com/environment/${index})`,
	).join(" ");
	const markdown = cleanMarkdown(links);
	expect(markdown).toContain("- [Environment 0]");
	expect(markdown).toContain("\n- [Environment 1]");
	expect(cleanMarkdown("###\n\n# Project\n\nUseful content.")).toBe(
		"# Project\n\nUseful content.",
	);
});

test("prefers a substantive article over repository navigation", () => {
	const navigation = Array.from(
		{ length: 24 },
		(_, index) => `<a href="/file/${index}">file-${index}</a>`,
	).join(" ");
	const article = `<article><h1>Project overview</h1><p>${"This project provides reliable tooling for agents that need to inspect and operate on public documentation. ".repeat(4)}</p></article>`;
	const document = parseHTML(`<main>${navigation}${article}</main>`).document;
	const result = structuredFallback(
		document,
		"https://github.com/example/repo",
	);
	expect(result.markdown).toContain("# Project overview");
	expect(result.markdown).toContain("reliable tooling for agents");
	expect(result.markdown).not.toContain("file-0");
});

test("keeps large content pages when only site navigation is link-heavy", async () => {
	const navigation = `<nav>${'<a href="/docs">Docs</a>'.repeat(600)}</nav>`;
	const [record] = await extractSeed(
		"https://docs.example.com/reference/command",
		`${navigation}${" ".repeat(500_000)}<main><h1>Command</h1><p>${"Run the command with the required arguments and inspect its output. ".repeat(12)}</p><pre>command --help</pre></main>`,
	);
	expect(record).toMatchObject({ ok: true });
	if (!record.ok) throw new Error("large content extract failed");
	expect(record.markdown).toContain("command --help");
	expect(record.markdown).not.toContain("Page Outline");
});

test("rejects a route fallback that reports a missing page", async () => {
	const [record] = await extractSeed(
		"https://docs.example.com/missing.md",
		"# Page Not Found\n\nThe requested URL does not exist.",
		{ contentType: "text/markdown" },
	);
	expect(record).toMatchObject({
		ok: false,
		failureKind: "not_found",
		error: "page reported not found",
	});
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
		error: "feed resource, not a content page",
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
	});
	expect(inlineShell).toBe(true);
	if (!inline.ok) throw new Error("inline-state extract failed");
	expect(inline.markdown).toContain("Install the command line package");
	expect(inline.qualityReasons).toContain("inline state may omit content");
});

test("runs structured-only extract for docs HTML", async () => {
	const [record, , shell] = await extractSeed(
		"https://docs.example.com/cli",
		`<html><head><title>CLI</title><meta name="generator" content="Docusaurus"></head><body><div id="__docusaurus"><nav>${"abcdefghijklmnopqrstuvwxyz"
			.split("")
			.map((letter) => `<a href="/${letter}">${letter}</a>`)
			.join(
				"",
			)}</nav><main><h1>CLI</h1><h2>Install</h2><pre>bun add -g docsnap</pre><p>Run the capture command against a public documentation site and write local Markdown files.</p><p><a href="https://raw.githubusercontent.com/example/docs/main/config.yaml">Download the example configuration</a>.</p><h2>Output</h2><p>Write clean Markdown with source URLs and titles for each captured page.</p></main></div></body></html>`,
	);
	expect(record).toMatchObject({
		ok: true,
		kind: "docs-html",
		extractor: "structured",
	});
	expect(shell).toBe(false);
	if (!record.ok) throw new Error("docs extract failed");
	expect(record.markdown).toContain("CLI");
});

test("uses the page heading instead of a shared site title", async () => {
	const [record] = await extractSeed(
		"https://docs.example.com/install",
		`<html><head><title>Transformers</title></head><body><main><h1>Installation</h1><p>${"Install and configure the library before loading a model. ".repeat(12)}</p></main></body></html>`,
	);
	expect(record).toMatchObject({ ok: true, title: "Installation" });
});

test("keeps paragraphs separated through nested custom elements", async () => {
	const first = "The first paragraph explains how to configure access safely.";
	const second = "The second paragraph explains how to verify the result.";
	const [record] = await extractSeed(
		"https://docs.example.com/access",
		`<main><docs-root><docs-layout><docs-content><h1>Access</h1><p>${first}</p><p>${second}</p></docs-content></docs-layout></docs-root></main>`,
	);
	if (!record.ok) throw new Error("nested documentation extract failed");
	expect(record.markdown).toContain(`${first}\n\n${second}`);
});

test("renders documentation tables as Markdown", async () => {
	const [record] = await extractSeed(
		"https://docs.example.com/errors",
		"<main><h1>Errors</h1><p>Error reference content for agents.</p><table><thead><tr><th>Code</th><th>Meaning</th></tr></thead><tbody><tr><td>400</td><td>Bad request</td></tr><tr><td>403</td><td>Access denied</td></tr></tbody></table></main>",
	);
	expect(record).toMatchObject({
		ok: true,
		kind: "docs-html",
		extractor: "structured",
	});
	if (!record.ok) throw new Error("documentation table extract failed");
	expect(record.markdown).toContain("| Code | Meaning |");
	expect(record.markdown).not.toContain("<table>");
});

test("runs Defuddle once for article HTML without swapping console", async () => {
	const error = console.error;
	const warn = console.warn;
	const stderr = process.stderr.write;
	const [record, , shell] = await extractSeed(
		"https://blog.example.com/hashing",
		`<html><head><title>Why hashing matters</title><script type="application/ld+json">{broken</script></head><body><article><h1>Why hashing matters</h1><p>Hash-verified documentation lets agents trust a local corpus after a capture run. Each page records a content hash so later refreshes can detect drift without rereading every file.</p><p>When a page changes, the writer replaces that Markdown file and updates the manifest. Unchanged pages keep their previous output path, title, and hash so local references stay stable.</p></article></body></html>`,
	);
	expect(console.error).toBe(error);
	expect(console.warn).toBe(warn);
	expect(process.stderr.write).toBe(stderr);
	expect(record).toMatchObject({
		ok: true,
		kind: "article-html",
		extractor: "html",
	});
	expect(shell).toBe(false);
	if (!record.ok) throw new Error("article extract failed");
	expect(record.markdown).toContain("Hash-verified documentation");
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
