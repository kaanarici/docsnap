import { describe, expect, test } from "bun:test";
import { parseHTML } from "linkedom";
import { type FetchedUrl, lowQualityConfidence } from "../src/core/types.ts";
import { extractPage } from "../src/extract/html.ts";
import { scoreMarkdown } from "../src/extract/quality.ts";
import { structuredFallback } from "../src/extract/structured-fallback.ts";
import { maxInlineChars } from "../src/extract/structured-fallback-shared.ts";

type Extracted = Awaited<ReturnType<typeof extractPage>>;
type Success = Extract<Extracted, { ok: true }>;

const mediaDecoy = `<article><img src="hero.png"><img src="icon.png"></article>`;

const forumBody = `<html><head><title>Forum Index</title></head><body>
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
						<div class="callout"><ul><li>Unsafe links remain plain text while public http and mail links can stay clickable.</li></ul></div>
					</li>
				</ul>
			</section>
		</main>
		<footer>Terms Privacy Contact</footer>
	</body></html>`;

function expectOk(record: Extracted): Success {
	expect(record.ok).toBe(true);
	if (!record.ok) throw new Error(record.error);
	return record;
}

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

function assertBalancedDelimiters(markdown: string) {
	expect(tokenCount(markdown, "```") % 2).toBe(0);
	expect(tokenCount(markdown, "**") % 2).toBe(0);
	expect(singleAsteriskCount(markdown) % 2).toBe(0);
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
	return value.match(/(?<!\*)\*(?!\*)/g)?.length ?? 0;
}

describe("structured fallback captures document structure", () => {
	test("forum pages keep nested list items and drop footer chrome", async () => {
		const forum = expectOk(await page("forum", forumBody));
		expect(forum.extractor).toBe("structured");
		expect(forum.markdown).toContain("# Forum Index");
		expect(forum.markdown).toContain("## Announcements");
		expect(forum.markdown).toContain("- Extraction notes");
		expect(forum.markdown).toContain("  - Structured fallback keeps nested");
		expect(forum.markdown).toContain("  - Unsafe links remain plain text");
		expect(forum.markdown).not.toContain("Terms Privacy");
	});

	test("multi-column data tables render as GitHub markdown tables", async () => {
		const product = expectOk(
			await page(
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
			),
		);
		expect(product.extractor).toBe("structured");
		expect(product.markdown).toContain("# Capture Plans");
		expect(product.markdown).toContain("| Plan | Limit | Use |");
		expect(product.markdown).toContain("| --- | --- | --- |");
		expect(product.markdown).toContain(
			"| Pro | Ten thousand pages | Agent-ready corpora |",
		);
		expect(product.markdown).not.toContain("**Plan**");
	});

	test("metadata tables preserve label and value relationships", async () => {
		const metadataTable = expectOk(
			await page(
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
			),
		);
		expect(metadataTable.extractor).toBe("structured");
		expect(metadataTable.markdown).toContain("**Author**");
		expect(metadataTable.markdown).toContain(": Guido");
		expect(metadataTable.markdown).toContain("**Status**");
		expect(metadataTable.markdown).not.toContain("Author - Guido");
	});

	test("code blocks keep language and indentation", async () => {
		const codeDoc = expectOk(
			await page(
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
			),
		);
		expect(codeDoc.extractor).toBe("structured");
		expect(codeDoc.markdown).toContain("```ts");
		expect(codeDoc.markdown).toContain('  url: "https://example.com/docs",');
		expect(codeDoc.markdown).toContain("console.log(result.markdown);");
	});

	test("definition lists keep term and definition boundaries", async () => {
		const definitionList = expectOk(
			await page(
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
			),
		);
		expect(definitionList.extractor).toBe("structured");
		expect(definitionList.markdown).toContain("**timeout**");
		expect(definitionList.markdown).toContain(
			": Maximum milliseconds to wait before a public capture is abandoned.",
		);
		expect(definitionList.markdown).toContain("**retries**");
		expect(definitionList.markdown).not.toMatch(
			/timeout\s+Maximum milliseconds/,
		);
	});

	test("metadata definition lists keep labels and nested values associated", async () => {
		const metadataDefinitionList = expectOk(
			await page(
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
			),
		);
		expect(metadataDefinitionList.markdown).toContain("**Author**");
		expect(metadataDefinitionList.markdown).toContain(": Guido");
		expect(metadataDefinitionList.markdown).toContain(": Barry Warsaw");
		expect(metadataDefinitionList.markdown).toContain("**RFC**");
		expect(metadataDefinitionList.markdown).toContain(": 2119");
		expect(metadataDefinitionList.markdown).not.toMatch(/Author\s+Guido/);
	});

	test("nested definitions do not leak empty outer terms", () => {
		const { document: nestedTermDocument } = parseHTML(
			`<html><body><main><h1>Nested Definitions</h1><p>Public reference pages sometimes nest a definition list inside a term, and the outer value must stay readable for agents reviewing the captured corpus archive.</p><dl><dt><dl><dt>inner label</dt><dd>inner value for the nested entry</dd></dl></dt><dd>outer value without a label of its own</dd></dl></main></body></html>`,
		);
		const nestedTermMarkdown = structuredFallback(
			nestedTermDocument,
			"https://docs.example.com/nested-definitions",
		);
		expect(nestedTermMarkdown).toContain("**inner label**");
		expect(nestedTermMarkdown).toContain(": inner value for the nested entry");
		expect(nestedTermMarkdown).not.toMatch(
			/(^|\n): outer value without a label/,
		);
		expect(nestedTermMarkdown).toContain(
			"outer value without a label of its own",
		);
	});
});

describe("structured fallback handles media and unsafe references", () => {
	test("block images keep useful alt text and drop decorative empty-alt images", async () => {
		const blockImage = expectOk(
			await page(
				"block-image",
				`<html><head><title>Architecture</title></head><body><main>
		${mediaDecoy}
		<h1>Architecture</h1>
		<p>Public architecture documentation describes the capture pipeline with a single explanatory diagram for downstream agents.</p>
		<img src="/diagram.png" alt="Pipeline diagram showing fetch then extract then write stages">
		<img srcset="/responsive-small.png 1x, /responsive-large.png 2x" alt="Topology">
		<img src="/spacer.png" alt="">
	</main></body></html>`,
			),
		);
		expect(blockImage.markdown).toContain(
			"![Pipeline diagram showing fetch then extract then write stages](/diagram.png)",
		);
		expect(blockImage.markdown).toContain("![Topology](/responsive-small.png)");
		expect(blockImage.markdown).not.toContain("/spacer.png");
	});

	test("unsafe image sources fall back to plain alt text", async () => {
		const unsafeImage = expectOk(
			await page(
				"unsafe-image",
				`<html><head><title>Unsafe Image</title></head><body><main>
		${mediaDecoy}
		<h1>Unsafe Image</h1>
		<p>Public documentation keeps image alt text while neutralizing an unsafe image source reference for safety.</p>
		<p><img src="javascript:alert(1)" alt="diagram caption that should remain as text"></p>
	</main></body></html>`,
			),
		);
		expect(unsafeImage.markdown).not.toContain("javascript:");
		expect(unsafeImage.markdown).toContain(
			"diagram caption that should remain as text",
		);
	});

	test("unsafe links are neutralized while safe links stay clickable", async () => {
		const unsafeLinks = expectOk(
			await page(
				"unsafe-links",
				`<html><head><title>Unsafe Links</title></head><body><main>
		${mediaDecoy}
		<h1>Unsafe Links</h1>
		<p>Visible public documentation prose surrounds links so the extractor must preserve content while neutralizing unsafe markdown.</p>
		<p><a href="java
script:alert(1)">bad ](https://attacker.example) text</a></p>
		<p><a href="/safe">safe reference</a> and <a href="mailto:docs@example.com">email reference</a></p>
	</main></body></html>`,
			),
		);
		expect(unsafeLinks.markdown).not.toContain("javascript:");
		expect(unsafeLinks.markdown).not.toContain(
			"[bad ](https://attacker.example) text]",
		);
		expect(unsafeLinks.markdown).toContain(
			"bad \\](https://attacker.example) text",
		);
		expect(unsafeLinks.markdown).toContain("[safe reference](/safe)");
		expect(unsafeLinks.markdown).toContain(
			"[email reference](mailto:docs@example.com)",
		);
	});

	test("forged markdown link text is escaped when href is dangerous", async () => {
		const forgedText = expectOk(
			await page(
				"forged-link-text",
				`<html><head><title>Forged Link Text</title></head><body><main>
		${mediaDecoy}
		<h1>Forged Link Text</h1>
		<p>Visible public prose keeps the fixture above the structured threshold while rejecting a dangerous href.</p>
		<p><a href="data:text/html,evil">look ](https://forge.example) here</a></p>
	</main></body></html>`,
			),
		);
		expect(forgedText.markdown).not.toContain("data:text");
		expect(forgedText.markdown).not.toContain(
			"[look ](https://forge.example) here]",
		);
		expect(forgedText.markdown).toContain(
			"look \\](https://forge.example) here",
		);
	});
});

describe("structured fallback keeps output bounded", () => {
	const longCode = "const value = capturePublicDocs();\n".repeat(
		Math.ceil(maxInlineChars / 34) + 20,
	);
	const budgetEdgeText = "edge ".repeat(Math.ceil(maxInlineChars / 5) + 10);

	test.each([
		[
			"list long pre",
			"list-long-pre",
			`<html><head><title>List Long Pre</title></head><body><main>
		${mediaDecoy}
		<h1>List Long Pre</h1>
		<p>Public list documentation keeps markdown delimiters balanced when an inline code block is too large for the item budget.</p>
		<ul><li><pre><code>${longCode}</code></pre>${budgetEdgeText}<strong>bold tail</strong><em>italic tail</em></li></ul>
	</main></body></html>`,
		],
		[
			"quote long pre",
			"quote-long-pre",
			`<html><head><title>Quote Long Pre</title></head><body><main>
		${mediaDecoy}
		<h1>Quote Long Pre</h1>
		<p>Public quote documentation keeps markdown delimiters balanced when an inline pre block exceeds the quote budget.</p>
		<blockquote><pre><code>${longCode}</code></pre>${budgetEdgeText}<strong>bold tail</strong><em>italic tail</em></blockquote>
	</main></body></html>`,
		],
	])("%s keeps markdown delimiters balanced", async (_label, slug, body) => {
		const record = expectOk(await page(slug, body));
		assertBalancedDelimiters(record.markdown);
	});

	test("deep nesting remains reachable without recursive traversal failure", async () => {
		const deep = expectOk(
			await page(
				"deep",
				`<html><head><title>Deep Nest</title></head><body><main>${mediaDecoy}${"<div>".repeat(
					5_000,
				)}Deep public documentation content remains reachable without recursive traversal failure and keeps enough words for extraction confidence across nested public reference pages, implementation notes, and agent review archives.${"</div>".repeat(
					5_000,
				)}</main></body></html>`,
			),
		);
		expect(deep.markdown).toContain("Deep public documentation content");
	}, 30_000);

	test("wide sibling scans stay linear", () => {
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
		expect(wideMarkdown).toContain("# Wide Siblings");
		expect(wideMs).toBeLessThan(1500);
	});

	test("giant tables stay capped and bounded", async () => {
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
		const giant = expectOk(
			await page(
				"giant-table",
				`<html><head><title>Large Matrix</title></head><body><main>
		<form>
			<h1>Large Matrix</h1>
			<table><thead><tr><th>Name</th><th>Description</th></tr></thead><tbody>${giantRows}</tbody></table>
		</form>
	</main></body></html>`,
			),
		);
		expect(giant.extractor).toBe("structured");
		expect(performance.now() - giantStart).toBeLessThan(15_000);
		expect(giant.markdown.length).toBeLessThanOrEqual(220_000);
	}, 30_000);
});

describe("structured fallback handles fallback paths and skipped nodes", () => {
	test("degenerate pages stay on flat fallback", async () => {
		const degenerate = expectOk(
			await page(
				"degenerate",
				`<html><head><title>Plain Notice</title></head><body>
		<main><select><option>Plain public notice keeps flat fallback text non empty without enough structure words for markdown.</option></select></main>
	</body></html>`,
			),
		);
		expect(degenerate.extractor).toBe("fallback");
		expect(degenerate.markdown.toLowerCase()).toContain("plain public notice");
	});

	test("svg and canvas text are excluded from captured content", () => {
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
		expect(svgMarkdown).toContain("# Diagram Page");
		expect(svgMarkdown).toContain("capture pipeline stages");
		expect(svgMarkdown).not.toContain("SVGDIAGRAMLABELNOISE");
		expect(svgMarkdown).not.toContain("CANVASFALLBACKNOISE");
	});

	test("ragged tables degrade to prose instead of malformed tables", async () => {
		const ragged = expectOk(
			await page(
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
			),
		);
		expect(ragged.markdown).not.toContain("| --- |");
		expect(ragged.markdown).not.toContain("| Too | Many | Cells |");
		expect(ragged.markdown).toContain("Too - Many - Cells");
	});
});

describe("structured fallback scoring", () => {
	test("structured forum output scores at least as well as flat output", async () => {
		const forum = expectOk(await page("forum", forumBody));
		const structuredScore = scoreMarkdown(
			forum.markdown,
			forum.title,
		).confidence;
		const flatScore = scoreMarkdown(
			"Forum Index Release discussions summarize extraction behavior for public documentation archives, agent review, and repeatable capture workflows. Announcements Extraction notes Structured fallback keeps nested list items and heading boundaries visible for reviewers. Security notes Unsafe links remain plain text while public http and mail links can stay clickable.",
			forum.title,
		).confidence;
		expect(structuredScore).toBeGreaterThanOrEqual(flatScore);
		expect(forum.confidence).toBeGreaterThanOrEqual(lowQualityConfidence);
	});
});
