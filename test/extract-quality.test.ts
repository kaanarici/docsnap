import { describe, expect, test } from "bun:test";
import { type FetchedUrl, lowQualityConfidence } from "../src/core/types.ts";
import { extractPage } from "../src/extract/html.ts";

type Extracted = Awaited<ReturnType<typeof extractPage>>;
type Success = Extract<Extracted, { ok: true }>;

function extract(body: string, slug = "page"): Promise<Extracted> {
	return extractPage({
		source: "seed",
		result: {
			ok: true,
			url: `https://quality.example.com/${slug}`,
			finalUrl: `https://quality.example.com/${slug}`,
			status: 200,
			contentType: "text/html; charset=utf-8",
			body,
			fetchMs: 1,
		},
	} satisfies FetchedUrl);
}

function expectOk(record: Extracted): Success {
	expect(record.ok).toBe(true);
	if (!record.ok) throw new Error(record.error);
	return record;
}

// boilerplate that must never reach the captured corpus
const boilerplate = {
	cookie: "COOKIE_NOTICE_SHOULD_NOT_SURVIVE",
	footer: "FOOTER_BOILERPLATE_SHOULD_NOT_SURVIVE",
	nav: "NAV_BOILERPLATE_SHOULD_NOT_SURVIVE",
};

const para =
	"The deployment pipeline promotes a build through staging and production while " +
	"recording every step so that an operator can audit what changed and when. " +
	"Each release is immutable, addressed by content hash, and rolled out behind a " +
	"health gate that watches latency and error rate before shifting more traffic. " +
	"When a regression appears the gate halts the rollout and the previous release " +
	"continues to serve requests without manual intervention or downtime for users.";

describe("extraction keeps content, drops chrome", () => {
	test("article: title, heading, fenced code, and link survive; boilerplate stripped", async () => {
		const r = expectOk(
			await extract(
				`<html><head><title>Capture API Guide</title></head><body>
			<nav>${boilerplate.nav}</nav>
			<aside>${boilerplate.cookie}</aside>
			<main>
				<article>
					<h1>Capture API Guide</h1>
					<p>The capture API turns public documentation into durable Markdown so agents can inspect pages, compare behavior, and rerun quality checks.</p>
					<h2>Install</h2>
					<p>Install the command line client from the package registry and point it at a public documentation root.</p>
					<pre><code class="language-ts">const result = await extractPage({
  source: "seed",
});
console.log(result.ok);</code></pre>
					<p>Read the <a href="/reference">API reference</a> before wiring it into automated capture jobs.</p>
				</article>
			</main>
			<footer>${boilerplate.footer}</footer>
		</body></html>`,
				"article",
			),
		);
		expect(r.confidence).toBeGreaterThanOrEqual(lowQualityConfidence);
		expect(r.title).toBe("Capture API Guide");
		expect(r.markdown).toContain("## Install");
		const fences = r.markdown.match(/```/g)?.length ?? 0;
		expect(fences).toBeGreaterThanOrEqual(2);
		expect(fences % 2).toBe(0);
		expect(r.links.some((link) => link.endsWith("/reference"))).toBe(true);
		for (const value of Object.values(boilerplate)) {
			expect(r.markdown).not.toContain(value);
		}
	});

	// the cheap structured extractor handles confident prose with a semantic root OR
	// a root it locates itself, skipping the costly Defuddle pass either way
	test.each([
		["semantic main/article root", "<main><article>", "</article></main>"],
		[
			"no container, plain nested divs",
			`<div class="content"><div class="doc">`,
			"</div></div>",
		],
	])("fast path stays structured: %s", async (_label, open, close) => {
		const r = expectOk(
			await extract(
				`<html><head><title>Guide</title></head><body>
			<nav>${boilerplate.nav}</nav>
			${open}
				<h1>Guide</h1><p>${para}</p>
				<h2>Options</h2><p>${para}</p>
				<h2>Defaults</h2><p>${para} Read the <a href="/runbook">runbook</a>.</p>
			${close}
			<footer>${boilerplate.footer}</footer>
		</body></html>`,
			),
		);
		expect(r.extractor).toBe("structured");
		expect(r.markdown).toContain("## Options");
		expect(r.links.some((link) => link.endsWith("/runbook"))).toBe(true);
		for (const value of Object.values(boilerplate)) {
			expect(r.markdown).not.toContain(value);
		}
	});

	test("oversized image alt is collapsed and capped, card text kept", async () => {
		const longAlt = [
			"Mandatory Credit Stock Agency. A staged photograph of several smiling people looking at a laptop in a bright office while generic documents appear on the table.",
			"Mandatory Credit Stock Agency. The same caption continues with location notes, licensing terms, background descriptions, and unrelated visual trivia.",
			"Mandatory Credit Stock Agency. This oversized caption should remain image alt metadata instead of becoming body prose in the extracted corpus.",
		].join("\n");
		const r = expectOk(
			await extract(
				`<html><head><title>Resource Cards</title></head><body><main>
			<h1>Resource Cards</h1>
			<p>Reference cards help developers choose capture workflows, compare validation signals, and route follow-up audits without reading every page first.</p>
			<section><h2>Recommended resources</h2><article>
				<img src="/img/workflow.jpg" alt="${longAlt}">
				<h3>Workflow checklist</h3>
				<p>Use this card when preparing a repeatable documentation archive for release review and automated extraction checks.</p>
			</article></section>
		</main></body></html>`,
			),
		);
		const alt = r.markdown.match(/!\[([^\]]*)\]\([^)]+\)/)?.[1] ?? "";
		expect(alt.length).toBeGreaterThan(0);
		expect(alt.length).toBeLessThanOrEqual(255);
		expect(alt).not.toContain("\n");
		expect(r.markdown).toContain("Workflow checklist");
	});

	test("standalone ad-slot labels are dropped, real steps kept", async () => {
		const r = expectOk(
			await extract(
				`<html><head><title>Migration Steps</title></head><body><main><article>
			<h1>Migration Steps</h1>
			<p>Teams migrate documentation archives in short repeatable steps so review agents can compare generated Markdown across releases.</p>
			<h2>Steps</h2>
			<p>First, export the public page list.</p>
			<p>Advertisement</p>
			<p>Second, run the capture command and inspect the changed Markdown files.</p>
			<p>Sponsored</p>
			<p>Finally, keep the regression result attached to the release checklist.</p>
		</article></main></body></html>`,
			),
		);
		expect(r.markdown).not.toMatch(/^Advertisement$/im);
		expect(r.markdown).not.toMatch(/^Sponsored$/im);
		expect(r.markdown).toContain("First, export");
		expect(r.markdown).toContain("Second, run");
		expect(r.markdown).toContain("Finally, keep");
	});

	test("metadata label/value lines stay on their own line, not fused", async () => {
		const r = expectOk(
			await extract(
				`<html><head><title>Release Metadata</title></head><body><main>
			<h1>Release Metadata</h1>
			<p>This release note documents who owns the extraction quality gate, which status is visible to reviewers, and how automation should treat the page.</p>
			<section><p>Author: Documentation Team</p><p>Status: Stable regression guard</p></section>
			<p>The metadata block must stay readable when downstream agents scan the extracted Markdown quickly.</p>
		</main></body></html>`,
			),
		);
		expect(r.markdown).toMatch(/^Author: Documentation Team$/m);
		expect(r.markdown).toMatch(/^Status: Stable regression guard$/m);
		expect(r.markdown).not.toMatch(/Author:[^\n]+Status:/);
	});

	test("table renders as GFM or degrades cleanly without raw cell tags", async () => {
		const r = expectOk(
			await extract(
				`<html><head><title>Command Matrix</title></head><body><main>
			<h1>Command Matrix</h1>
			<p>The command matrix maps common capture tasks to the exact command a release reviewer should run before accepting generated Markdown.</p>
			<table>
				<thead><tr><th>Command</th><th>Purpose</th></tr></thead>
				<tbody>
					<tr><td>docsnap capture</td><td>Archive public documentation into Markdown.</td></tr>
					<tr><td>docsnap check</td><td>Validate extraction confidence and write a local summary.</td></tr>
				</tbody>
			</table>
		</main></body></html>`,
			),
		);
		const gfm =
			r.markdown.includes("| Command | Purpose |") &&
			r.markdown.includes("| --- | --- |");
		const degraded =
			r.markdown.includes("Command") &&
			r.markdown.includes("Archive public documentation into Markdown.") &&
			!/<t[dh]\b/i.test(r.markdown);
		expect(gfm || degraded).toBe(true);
	});
});

describe("app shells fail honestly", () => {
	// each has no recoverable static prose; the only "content" is a placeholder,
	// a meta description, or a nav skeleton, so the page must fail empty
	test.each([
		[
			"loading-text placeholder",
			`<html><head><title>Docs</title><link rel="stylesheet" href="/app.css"></head><body><main>Loading documentation, please wait...</main><script src="/app.js"></script></body></html>`,
			"app shell without static text",
		],
		[
			"og:description-only shell",
			`<html><head><title>My App</title><meta property="og:description" content="Build fast. Deploy everywhere. Scale infinitely. Start for free today."></head><body><catalog-app></catalog-app><script src="/app.js"></script></body></html>`,
			undefined,
		],
		[
			"nav-link skeleton (defeats the link-count heuristic) with only a meta description",
			`<html><head><title>My App</title><meta property="og:description" content="Build fast. Deploy everywhere. Scale infinitely. Start for free today."></head><body><nav><a href="/a">A</a><a href="/b">B</a><a href="/c">C</a><a href="/d">D</a><a href="/e">E</a><a href="/f">F</a></nav><script src="/app.js"></script></body></html>`,
			undefined,
		],
	])("%s → empty", async (_label, body, error) => {
		const r = await extract(body);
		expect(r.ok).toBe(false);
		if (r.ok) return;
		expect(r.failureKind).toBe("empty");
		if (error) expect(r.error).toBe(error);
	});

	test("an app-shell marker plus real body text is NOT blanked", async () => {
		const r = expectOk(
			await extract(
				`<html><head><title>Guide</title><meta property="og:description" content="A short marketing description for the page."></head><body><catalog-app></catalog-app><main><h1>Guide</h1><p>This page has real captured documentation text describing how the capture pipeline turns public pages into clean Markdown for agents to read and reuse.</p></main><script src="/app.js"></script></body></html>`,
			),
		);
		expect(r.markdown).toContain("real captured documentation text");
	});
});
