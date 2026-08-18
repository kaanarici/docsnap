import { expect, test } from "bun:test";
import { parseHTML } from "linkedom";
import { extractPage } from "../src/extract/html.ts";
import { extractInlineState } from "../src/extract/inline-state.ts";
import { scriptBlocks } from "../src/extract/inline-state-scan.ts";
import { okFetch } from "./fixtures.ts";

test("rejects repeated marketing variants as page content", async () => {
	const repeated = [
		"Search, enrich, and reason over 1.4 billion people in real time. Social profiles, professional data, behavioral signals — the most complete people intelligence platform ever built.",
		"Search, enrich, and reason over 3B people in real time. Social profiles, professional data, behavioral signals — all in one place.",
		"Search, enrich, and reason over 3B people in real time.",
	];
	expect(extractRsc(repeated)).toBeUndefined();
	const [record] = await extractPage({
		source: "seed",
		wasSeed: true,
		result: okFetch("https://docs.example.com/pricing", rscHtml(repeated)),
	});
	expect(record).toMatchObject({ ok: false, failureKind: "empty" });
});

test("keeps distinct inline documentation prose", () => {
	const extracted = extractRsc([
		"Install the command line package and configure the project before capturing your first documentation site.",
		"The capture command follows public links, records failures, and writes clean Markdown files with source metadata.",
		"Review the generated summary and manifest to verify page counts, redirects, content hashes, and quality warnings.",
	]);
	expect(extracted?.source).toBe("rsc");
	expect(extracted?.markdown).toContain("Install the command line package");
	expect(extracted?.markdown).toContain("Review the generated summary");
});

function extractRsc(paragraphs: string[]) {
	const html = rscHtml(paragraphs);
	const document = parseHTML(html).document;
	return extractInlineState(html, "https://docs.example.com/guide", {
		scripts: scriptBlocks(document),
		title: document.title,
	});
}

function rscHtml(paragraphs: string[]) {
	const payload = paragraphs.map((text) => JSON.stringify(text)).join(",");
	return `<html><head><title>Docs</title></head><body><div id="__next"></div><script>self.__next_f.push([1,${JSON.stringify(payload)}])</script></body></html>`;
}
