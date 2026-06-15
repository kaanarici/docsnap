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
assert(
	!product.markdown.includes("**Plan**"),
	"normal multi-column data table should stay on renderTable path",
);

const metadataTable = await page(
	"metadata-table",
	`<html><head><title>Protocol Metadata</title></head><body><main>
		${mediaDecoy}
		<h1>Protocol Metadata</h1>
		<p>Specification pages publish compact metadata tables before the narrative so agents need the label and value relationship preserved.</p>
		<table>
			<tbody>
				<tr><td>Author</td><td>Guido</td></tr>
				<tr><td>Status</td><td>Active</td></tr>
				<tr><td>Version</td><td>3.14</td></tr>
			</tbody>
		</table>
	</main></body></html>`,
);
assertOk(metadataTable);
assert(
	metadataTable.extractor === "structured",
	"metadata table should use structured fallback",
);
assert(metadataTable.markdown.includes("**Author**"));
assert(metadataTable.markdown.includes(": Guido"));
assert(metadataTable.markdown.includes("**Status**"));
assert(!metadataTable.markdown.includes("Author - Guido"));

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

const definitionList = await page(
	"definition-list",
	`<html><head><title>API Options</title></head><body><main>
		${mediaDecoy}
		<h1>API Options</h1>
		<p>Public reference documentation lists capture options as a definition list for agents and human reviewers alike.</p>
		<dl>
			<dt>timeout</dt>
			<dd>Maximum milliseconds to wait before a public capture is abandoned.</dd>
			<dt>retries</dt>
			<dd>Number of additional attempts when a transient network failure occurs.</dd>
		</dl>
	</main></body></html>`,
);
assertOk(definitionList);
assert(
	definitionList.extractor === "structured",
	"definition list should use structured",
);
assert(definitionList.markdown.includes("**timeout**"));
assert(
	definitionList.markdown.includes(
		": Maximum milliseconds to wait before a public capture is abandoned.",
	),
);
assert(definitionList.markdown.includes("**retries**"));
// the term/definition boundary must survive (not fused into one run-on line)
assert(
	!/timeout\s+Maximum milliseconds/.test(definitionList.markdown),
	"definition terms and values must not fuse into a run-on",
);

const metadataDefinitionList = await page(
	"metadata-definition-list",
	`<html><head><title>PEP Metadata</title></head><body><main>
		${mediaDecoy}
		<h1>PEP Metadata</h1>
		<p>Python enhancement proposal pages expose metadata as definition blocks whose labels and values must stay associated.</p>
		<dl>
			<div><dt><span>Author</span></dt><dd>Guido</dd><dd>Barry Warsaw</dd></div>
			<dt></dt><dd>Editorial note without a label remains readable.</dd>
			<dt>Status</dt><dd>Active</dd>
			<dt>References</dt><dd>Normative references<dl><dt>RFC</dt><dd>2119</dd></dl></dd>
		</dl>
	</main></body></html>`,
);
assertOk(metadataDefinitionList);
assert(metadataDefinitionList.markdown.includes("**Author**"));
assert(metadataDefinitionList.markdown.includes(": Guido"));
assert(metadataDefinitionList.markdown.includes(": Barry Warsaw"));
assert(metadataDefinitionList.markdown.includes("**RFC**"));
assert(metadataDefinitionList.markdown.includes(": 2119"));
assert(
	!/Author\s+Guido/.test(metadataDefinitionList.markdown),
	"metadata definition terms and values must not fuse",
);

// nested <dl> inside an EMPTY outer <dt> must not leak the inner term into the outer <dd>
const { document: nestedTermDocument } = parseHTML(
	`<html><body><main><h1>Nested Definitions</h1><p>Public reference pages sometimes nest a definition list inside a term, and the outer value must stay readable for agents reviewing the captured corpus archive.</p><dl><dt><dl><dt>inner label</dt><dd>inner value for the nested entry</dd></dl></dt><dd>outer value without a label of its own</dd></dl></main></body></html>`,
);
const nestedTermMarkdown = structuredFallback(
	nestedTermDocument,
	"https://docs.example.com/nested-definitions",
);
assert(nestedTermMarkdown.includes("**inner label**"));
assert(nestedTermMarkdown.includes(": inner value for the nested entry"));
assert(
	!/(^|\n): outer value without a label/.test(nestedTermMarkdown),
	"empty outer term leaked a colon prefix into the outer definition",
);
assert(
	nestedTermMarkdown.includes("outer value without a label of its own"),
	"outer definition value was lost",
);

// block-level img (direct child of main) exercises the render path; empty-alt is decorative
const blockImage = await page(
	"block-image",
	`<html><head><title>Architecture</title></head><body><main>
		${mediaDecoy}
		<h1>Architecture</h1>
		<p>Public architecture documentation describes the capture pipeline with a single explanatory diagram for downstream agents.</p>
		<img src="/diagram.png" alt="Pipeline diagram showing fetch then extract then write stages">
		<img src="/spacer.png" alt="">
	</main></body></html>`,
);
assertOk(blockImage);
assert(
	blockImage.markdown.includes(
		"![Pipeline diagram showing fetch then extract then write stages](/diagram.png)",
	),
	"content-bearing block image alt must be preserved",
);
assert(
	!blockImage.markdown.includes("/spacer.png"),
	"decorative empty-alt image must be dropped",
);

const unsafeImage = await page(
	"unsafe-image",
	`<html><head><title>Unsafe Image</title></head><body><main>
		${mediaDecoy}
		<h1>Unsafe Image</h1>
		<p>Public documentation keeps image alt text while neutralizing an unsafe image source reference for safety.</p>
		<p><img src="javascript:alert(1)" alt="diagram caption that should remain as text"></p>
	</main></body></html>`,
);
assertOk(unsafeImage);
assert(!unsafeImage.markdown.includes("javascript:"));
assert(
	unsafeImage.markdown.includes("diagram caption that should remain as text"),
	"unsafe image src falls back to plain alt text",
);

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

// svg/canvas text is deliberately excluded from captured content (decorative
// diagram labels / accessibility fallbacks, not prose). The flat-walker dedup
// made the fallback path consistent with the structured path's existing skip;
// drive structuredFallback directly to lock that skip set.
const { document: svgDocument } = parseHTML(
	`<html><body><main>
		<h1>Diagram Page</h1>
		<p>Public architecture documentation explains the capture pipeline stages for downstream agents in clear readable prose.</p>
		<svg><text>SVGDIAGRAMLABELNOISE coordinates legend axis</text></svg>
		<canvas>CANVASFALLBACKNOISE rendering context</canvas>
	</main></body></html>`,
);
const svgMarkdown = structuredFallback(
	svgDocument,
	"https://docs.example.com/diagram",
);
assert(svgMarkdown.includes("# Diagram Page"));
assert(svgMarkdown.includes("capture pipeline stages"));
assert(!svgMarkdown.includes("SVGDIAGRAMLABELNOISE"));
assert(!svgMarkdown.includes("CANVASFALLBACKNOISE"));

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
