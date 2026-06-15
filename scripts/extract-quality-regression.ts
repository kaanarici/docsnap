import { type FetchedUrl, lowQualityConfidence } from "../src/core/types.ts";
import { extractPage } from "../src/extract/html.ts";

type Record = Awaited<ReturnType<typeof extractPage>>;
type Success = Extract<Record, { ok: true }>;

const boilerplate = {
	cookie: "COOKIE_NOTICE_SHOULD_NOT_SURVIVE",
	footer: "FOOTER_BOILERPLATE_SHOULD_NOT_SURVIVE",
	nav: "NAV_BOILERPLATE_SHOULD_NOT_SURVIVE",
};

const article = await page(
	"article",
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
);
assertOk(article);
assert(article.confidence >= lowQualityConfidence, "article confidence fell");
assert(article.title === "Capture API Guide", "missing h1/title boundary");
assert(article.markdown.includes("## Install"), "missing h2");
assert(codeFenceCount(article.markdown) >= 2, "missing fenced code block");
assert(codeFenceCount(article.markdown) % 2 === 0, "unbalanced code fences");
assert(
	article.links.some((link) => link.endsWith("/reference")),
	"article link was lost",
);
for (const value of Object.values(boilerplate)) {
	assert(!article.markdown.includes(value), `boilerplate survived: ${value}`);
}
pass("article", article);

const longAlt = [
	"Mandatory Credit Stock Agency. A staged photograph of several smiling people looking at a laptop in a bright office while generic documents appear on the table.",
	"Mandatory Credit Stock Agency. The same caption continues with location notes, licensing terms, background descriptions, and unrelated visual trivia.",
	"Mandatory Credit Stock Agency. This oversized caption should remain image alt metadata instead of becoming body prose in the extracted corpus.",
].join("\n");
assert(longAlt.length > 400, "long alt fixture must stay oversized");
const listing = await page(
	"listing",
	`<html><head><title>Resource Cards</title></head><body><main>
		<h1>Resource Cards</h1>
		<p>Reference cards help developers choose capture workflows, compare validation signals, and route follow-up audits without reading every page first.</p>
		<section>
			<h2>Recommended resources</h2>
			<article>
				<img src="/img/workflow.jpg" alt="${longAlt}">
				<h3>Workflow checklist</h3>
				<p>Use this card when preparing a repeatable documentation archive for release review and automated extraction checks.</p>
			</article>
		</section>
	</main></body></html>`,
);
assertOk(listing);
const alt = imageAlt(listing.markdown);
assert(alt, `image alt missing from listing:\n${listing.markdown}`);
assert(alt.length <= 255, `image alt too long: ${alt.length}`);
assert(!alt.includes("\n"), "image alt was not collapsed to one line");
assert(
	listing.markdown.includes("Workflow checklist"),
	"listing card text was lost",
);
pass("listing", listing, `alt=${alt.length}`);

const adSupported = await page(
	"ad-supported",
	`<html><head><title>Migration Steps</title></head><body><main>
		<article>
			<h1>Migration Steps</h1>
			<p>Teams migrate documentation archives in short repeatable steps so review agents can compare generated Markdown across releases.</p>
			<h2>Steps</h2>
			<p>First, export the public page list.</p>
			<p>Advertisement</p>
			<p>Second, run the capture command and inspect the changed Markdown files.</p>
			<p>Sponsored</p>
			<p>Finally, keep the regression result attached to the release checklist.</p>
		</article>
	</main></body></html>`,
);
assertOk(adSupported);
assert(!/^Advertisement$/im.test(adSupported.markdown), "ad label leaked");
assert(!/^Sponsored$/im.test(adSupported.markdown), "sponsored label leaked");
assert(adSupported.markdown.includes("First, export"), "first step missing");
assert(adSupported.markdown.includes("Second, run"), "second step missing");
assert(adSupported.markdown.includes("Finally, keep"), "final step missing");
pass("ad-supported", adSupported);

const metadata = await page(
	"metadata",
	`<html><head><title>Release Metadata</title></head><body><main>
		<h1>Release Metadata</h1>
		<p>This release note documents who owns the extraction quality gate, which status is visible to reviewers, and how automation should treat the page.</p>
		<section>
			<p>Author: Documentation Team</p>
			<p>Status: Stable regression guard</p>
		</section>
		<p>The metadata block must stay readable when downstream agents scan the extracted Markdown quickly.</p>
	</main></body></html>`,
);
assertOk(metadata);
assert(/^Author: Documentation Team$/m.test(metadata.markdown), "author fused");
assert(
	/^Status: Stable regression guard$/m.test(metadata.markdown),
	"status fused",
);
assert(
	!/Author:[^\n]+Status:/.test(metadata.markdown),
	"metadata terms fused into a run-on",
);
pass("metadata", metadata);

const shell = await page(
	"loading-shell",
	`<html><head><title>Docs</title><link rel="stylesheet" href="/app.css"></head>
	<body><main>Loading documentation, please wait...</main><script src="/app.js"></script></body></html>`,
);
assert(!shell.ok, "app shell was captured as a clean page");
assert(shell.failureKind === "empty", `shell failure was ${shell.failureKind}`);
pass("app-shell", shell);

// An app shell whose only "content" is its og/twitter description meta tag must
// fail honestly, not masquerade as a captured page.
const metaShell = await page(
	"meta-shell",
	`<html><head><title>My App</title>
	<meta property="og:description" content="Build fast. Deploy everywhere. Scale infinitely. Start for free today.">
	</head><body><catalog-app></catalog-app><script src="/app.js"></script></body></html>`,
);
assert(!metaShell.ok, "og:description shell was captured as a clean page");
assert(
	metaShell.failureKind === "empty",
	`meta shell failure was ${metaShell.failureKind}`,
);
pass("meta-shell", metaShell);

// A page with an app-shell marker but real captured body text must NOT be blanked.
const markedReal = await page(
	"marked-real",
	`<html><head><title>Guide</title>
	<meta property="og:description" content="A short marketing description for the page.">
	</head><body><catalog-app></catalog-app><main><h1>Guide</h1>
	<p>This page has real captured documentation text describing how the capture pipeline turns public pages into clean Markdown for agents to read and reuse.</p>
	</main><script src="/app.js"></script></body></html>`,
);
assertOk(markedReal);
assert(
	markedReal.markdown.includes("real captured documentation text"),
	"app-shell marker wrongly blanked a real content page",
);
pass("marked-real", markedReal);

const table = await page(
	"table",
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
);
assertOk(table);
const hasGithubTable =
	table.markdown.includes("| Command | Purpose |") &&
	table.markdown.includes("| --- | --- |") &&
	table.markdown.includes(
		"| docsnap capture | Archive public documentation into Markdown. |",
	);
const hasCleanDegrade =
	table.markdown.includes("Command") &&
	table.markdown.includes("Purpose") &&
	table.markdown.includes("docsnap capture") &&
	table.markdown.includes("Archive public documentation into Markdown.") &&
	!/<t[dh]\b/i.test(table.markdown);
assert(
	hasGithubTable || hasCleanDegrade,
	`bad table output:\n${table.markdown}`,
);
pass("table", table, hasGithubTable ? "table=gfm" : "table=degraded");

async function page(slug: string, body: string) {
	return await extractPage({
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

function assertOk(record: Record): asserts record is Success {
	assert(record.ok, record.ok ? "ok" : record.error);
}

function assert(
	condition: unknown,
	message = "assertion failed",
): asserts condition {
	if (!condition) throw new Error(message);
}

function pass(label: string, record: Record, extra?: string) {
	const words = record.markdown.split(/\s+/).filter(Boolean).length;
	const summary = record.ok
		? `extractor=${record.extractor} confidence=${record.confidence} words=${words} links=${record.links.length}`
		: `failure=${record.failureKind}`;
	console.log(`PASS ${label}: ${summary}${extra ? ` ${extra}` : ""}`);
}

function codeFenceCount(markdown: string) {
	return markdown.match(/```/g)?.length ?? 0;
}

function imageAlt(markdown: string) {
	return markdown.match(/!\[([^\]]*)\]\([^)]+\)/)?.[1] ?? "";
}
