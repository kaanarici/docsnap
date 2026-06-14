import { parseHTML } from "linkedom";
import { type FetchedUrl, lowQualityConfidence } from "../src/core/types.ts";
import { extractPage } from "../src/extract/html.ts";
import { scoreMarkdown } from "../src/extract/quality.ts";
import { structuredFallback } from "../src/extract/structured-fallback.ts";
import { maxInlineChars } from "../src/extract/structured-fallback-shared.ts";

const mediaDecoy = `<article><img src="hero.png"><img src="icon.png"></article>`;

const forum = await page(
	"forum",
	`<html><head><title>Forum Index</title></head><body>
		<header><a href="/">Home</a><a href="/login">Sign in</a></header>
		<main>
			${mediaDecoy}
			<section>
				<h1>Forum Index</h1>
				<p>Release discussions summarize extraction behavior for public documentation archives, agent review, and repeatable capture workflows.</p>
				<h2>Announcements</h2>
				<ul>
					<li>Extraction notes
						<ul><li>Structured fallback keeps nested list items and heading boundaries visible for reviewers.</li></ul>
					</li>
					<li>Security notes
						<ul><li>Unsafe links remain plain text while public http and mail links can stay clickable.</li></ul>
					</li>
				</ul>
			</section>
		</main>
		<footer>Terms Privacy Contact</footer>
	</body></html>`,
);
assertOk(forum);
assert(
	forum.extractor === "structured",
	"forum should use structured fallback",
);
assert(forum.markdown.includes("# Forum Index"));
assert(forum.markdown.includes("## Announcements"));
assert(forum.markdown.includes("- Extraction notes"));
assert(forum.markdown.includes("  - Structured fallback keeps nested"));
assert(!forum.markdown.includes("Terms Privacy"));

const product = await page(
	"product",
	`<html><head><title>Capture Plans</title></head><body>
		<main>
			${mediaDecoy}
			<h1>Capture Plans</h1>
			<p>Teams compare capture plans before archiving public documentation, API references, changelogs, and implementation guides.</p>
			<table>
				<thead><tr><th>Plan</th><th>Limit</th><th>Use</th></tr></thead>
				<tbody>
					<tr><td>Free</td><td>One public capture</td><td>Small docs audits</td></tr>
					<tr><td>Pro</td><td>Ten thousand pages</td><td>Agent-ready corpora</td></tr>
				</tbody>
			</table>
		</main>
	</body></html>`,
);
assertOk(product);
assert(
	product.extractor === "structured",
	"product should use structured fallback",
);
assert(product.markdown.includes("# Capture Plans"));
assert(product.markdown.includes("| Plan | Limit | Use |"));
assert(product.markdown.includes("| --- | --- | --- |"));
assert(
	product.markdown.includes(
		"| Pro | Ten thousand pages | Agent-ready corpora |",
	),
);

const codeDoc = await page(
	"code",
	`<html><head><title>Client Setup</title></head><body>
		<main>
			${mediaDecoy}
			<h1>Client Setup</h1>
			<p>The client example keeps indentation stable so implementation agents can copy the public documentation snippet safely.</p>
			<pre><code class="language-ts">const result = await client.capture({
  url: "https://example.com/docs",
});
console.log(result.markdown);</code></pre>
		</main>
	</body></html>`,
);
assertOk(codeDoc);
assert(codeDoc.extractor === "structured", "code doc should use structured");
assert(codeDoc.markdown.includes("```ts"));
assert(codeDoc.markdown.includes('  url: "https://example.com/docs",'));
assert(codeDoc.markdown.includes("console.log(result.markdown);"));

const longCode = "const value = capturePublicDocs();\n".repeat(
	Math.ceil(maxInlineChars / 34) + 20,
);
const budgetEdgeText = "edge ".repeat(Math.ceil(maxInlineChars / 5) + 10);
const listLongPre = await page(
	"list-long-pre",
	`<html><head><title>List Long Pre</title></head><body><main>
		${mediaDecoy}
		<h1>List Long Pre</h1>
		<p>Public list documentation keeps markdown delimiters balanced when an inline code block is too large for the item budget.</p>
		<ul><li><pre><code>${longCode}</code></pre>${budgetEdgeText}<strong>bold tail</strong><em>italic tail</em></li></ul>
	</main></body></html>`,
);
assertOk(listLongPre);
assertBalancedDelimiters(listLongPre.markdown, "list long pre");

const quoteLongPre = await page(
	"quote-long-pre",
	`<html><head><title>Quote Long Pre</title></head><body><main>
		${mediaDecoy}
		<h1>Quote Long Pre</h1>
		<p>Public quote documentation keeps markdown delimiters balanced when an inline pre block exceeds the quote budget.</p>
		<blockquote><pre><code>${longCode}</code></pre>${budgetEdgeText}<strong>bold tail</strong><em>italic tail</em></blockquote>
	</main></body></html>`,
);
assertOk(quoteLongPre);
assertBalancedDelimiters(quoteLongPre.markdown, "quote long pre");

const degenerate = await page(
	"degenerate",
	`<html><head><title>Plain Notice</title></head><body>
		<main><select><option>Plain public notice keeps flat fallback text non empty without enough structure words for markdown.</option></select></main>
	</body></html>`,
);
assertOk(degenerate);
assert(degenerate.extractor === "fallback", "degenerate should stay flat");
assert(degenerate.markdown.toLowerCase().includes("plain public notice"));

const deep = await page(
	"deep",
	`<html><head><title>Deep Nest</title></head><body><main>${mediaDecoy}${"<div>".repeat(
		5_000,
	)}Deep public documentation content remains reachable without recursive traversal failure and keeps enough words for extraction confidence across nested public reference pages, implementation notes, and agent review archives.${"</div>".repeat(
		5_000,
	)}</main></body></html>`,
);
assertOk(deep);
assert(deep.markdown.includes("Deep public documentation content"));

const wideSiblings = Array.from(
	{ length: 12_000 },
	(_, index) =>
		`<p>Wide sibling ${index} keeps structured fallback scans linear for public documentation extraction workflows.</p>`,
).join("");
const { document: wideDocument } = parseHTML(
	`<html><body><main><h1>Wide Siblings</h1>${wideSiblings}</main></body></html>`,
);
const wideStart = performance.now();
const wideMarkdown = structuredFallback(
	wideDocument,
	"https://docs.example.com/wide-siblings",
);
const wideMs = performance.now() - wideStart;
assert(wideMarkdown.includes("# Wide Siblings"));
assert(
	wideMs < 1500,
	`wide sibling structured fallback took ${wideMs.toFixed(1)}ms`,
);

const giantDescription =
	"Stable capture behavior for agent documentation workflows with bounded table traversal and predictable markdown output. ".repeat(
		5,
	);
const giantRows = Array.from(
	{ length: 3_800 },
	(_, index) =>
		`<tr><td>Public endpoint ${index}</td><td>${giantDescription}</td></tr>`,
).join("");
const giantStart = performance.now();
const giant = await page(
	"giant-table",
	`<html><head><title>Large Matrix</title></head><body><main>
		<form>
			<h1>Large Matrix</h1>
			<table><thead><tr><th>Name</th><th>Description</th></tr></thead><tbody>${giantRows}</tbody></table>
		</form>
	</main></body></html>`,
);
assertOk(giant);
assert(giant.extractor === "structured", "giant table should use structured");
assert(
	performance.now() - giantStart < 15_000,
	"giant table fixture should stay bounded",
);
assert(giant.markdown.length <= 220_000, "giant output should be capped");

const unsafeLinks = await page(
	"unsafe-links",
	`<html><head><title>Unsafe Links</title></head><body><main>
		${mediaDecoy}
		<h1>Unsafe Links</h1>
		<p>Visible public documentation prose surrounds links so the extractor must preserve content while neutralizing unsafe markdown.</p>
		<p><a href="java
script:alert(1)">bad ](https://attacker.example) text</a></p>
		<p><a href="/safe">safe reference</a> and <a href="mailto:docs@example.com">email reference</a></p>
	</main></body></html>`,
);
assertOk(unsafeLinks);
assert(!unsafeLinks.markdown.includes("javascript:"));
assert(
	!unsafeLinks.markdown.includes("[bad ](https://attacker.example) text]"),
);
assert(unsafeLinks.markdown.includes("bad \\](https://attacker.example) text"));
assert(unsafeLinks.markdown.includes("[safe reference](/safe)"));
assert(
	unsafeLinks.markdown.includes("[email reference](mailto:docs@example.com)"),
);

const forgedText = await page(
	"forged-link-text",
	`<html><head><title>Forged Link Text</title></head><body><main>
		${mediaDecoy}
		<h1>Forged Link Text</h1>
		<p>Visible public prose keeps the fixture above the structured threshold while rejecting a dangerous href.</p>
		<p><a href="data:text/html,evil">look ](https://forge.example) here</a></p>
	</main></body></html>`,
);
assertOk(forgedText);
assert(!forgedText.markdown.includes("data:text"));
assert(!forgedText.markdown.includes("[look ](https://forge.example) here]"));
assert(forgedText.markdown.includes("look \\](https://forge.example) here"));

const ragged = await page(
	"ragged",
	`<html><head><title>Ragged Table</title></head><body><main>
		${mediaDecoy}
		<h1>Ragged Table</h1>
		<p>Ragged public comparison data should degrade to prose instead of emitting malformed GitHub markdown tables.</p>
		<table>
			<tr><th>Name</th><th>Value</th></tr>
			<tr><td>Short</td></tr>
			<tr><td>Too</td><td>Many</td><td>Cells</td></tr>
		</table>
	</main></body></html>`,
);
assertOk(ragged);
assert(!ragged.markdown.includes("| --- |"));
assert(!ragged.markdown.includes("| Too | Many | Cells |"));
assert(ragged.markdown.includes("Too - Many - Cells"));

const structuredScore = scoreMarkdown(forum.markdown, forum.title).confidence;
const flatScore = scoreMarkdown(
	"Forum Index Release discussions summarize extraction behavior for public documentation archives, agent review, and repeatable capture workflows. Announcements Extraction notes Structured fallback keeps nested list items and heading boundaries visible for reviewers. Security notes Unsafe links remain plain text while public http and mail links can stay clickable.",
	forum.title,
).confidence;
assert(
	structuredScore >= flatScore,
	`structured score ${structuredScore} should be >= flat score ${flatScore}`,
);
assert(
	forum.confidence >= lowQualityConfidence,
	"structured forum confidence should clear the quality floor",
);

async function page(slug: string, body: string) {
	return await extractPage({
		source: "seed",
		result: {
			ok: true,
			url: `https://docs.example.com/${slug}`,
			finalUrl: `https://docs.example.com/${slug}`,
			status: 200,
			contentType: "text/html; charset=utf-8",
			body,
			fetchMs: 1,
		},
	} satisfies FetchedUrl);
}

function assertOk(
	record: Awaited<ReturnType<typeof extractPage>>,
): asserts record is Extract<
	Awaited<ReturnType<typeof extractPage>>,
	{ ok: true }
> {
	assert(record.ok, record.ok ? "ok" : record.error);
}

function assert(
	condition: unknown,
	message = "assertion failed",
): asserts condition {
	if (!condition) throw new Error(message);
}

function assertBalancedDelimiters(markdown: string, label: string) {
	assert(
		tokenCount(markdown, "```") % 2 === 0,
		`${label} has unbalanced code fences`,
	);
	assert(
		tokenCount(markdown, "**") % 2 === 0,
		`${label} has unbalanced strong delimiters`,
	);
	assert(
		singleAsteriskCount(markdown) % 2 === 0,
		`${label} has unbalanced emphasis delimiters`,
	);
}

function tokenCount(value: string, token: string) {
	let count = 0;
	let index = 0;
	while (true) {
		const next = value.indexOf(token, index);
		if (next < 0) return count;
		count++;
		index = next + token.length;
	}
}

function singleAsteriskCount(value: string) {
	let count = 0;
	for (let index = 0; index < value.length; index++) {
		if (
			value[index] === "*" &&
			value[index - 1] !== "*" &&
			value[index + 1] !== "*"
		) {
			count++;
		}
	}
	return count;
}
