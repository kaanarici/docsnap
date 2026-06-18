import { describe, expect, test } from "bun:test";
import {
	markdownLinkHrefs,
	replaceMarkdownLinks,
} from "../src/core/markdown.ts";
import { isLlmsCorpus } from "../src/discover/llms.ts";
import { parseRobots } from "../src/discover/robots.ts";
import { stripScriptStyleTags } from "../src/extract/html.ts";
import {
	extractSerializedText,
	numericCssNoise,
} from "../src/extract/serialized-text.ts";
import { refreshUrl } from "../src/fetch/refresh.ts";
import { globMatches } from "../src/mcp/glob.ts";

const maxMs = 200;

describe("path glob matching stays bounded", () => {
	test("pathological glob is linear and does not match", () => {
		const globPattern = `${"a*".repeat(25)}b`;
		const globTarget = `${"a".repeat(120)}c`;
		const globStart = performance.now();
		const globResult = globMatches(globPattern, globTarget);
		const globMs = performance.now() - globStart;
		expect(globResult).toBe(false);
		expect(globMs).toBeLessThan(maxMs);
	});

	test.each([
		["docs/*.md", "docs/intro.md", true],
		["docs/*.md", "blog/intro.md", false],
		["a?c/*", "abc/x", true],
		["a?c", "abcd", false],
	])("%s against %s", (pattern, target, expected) => {
		expect(globMatches(pattern, target)).toBe(expected);
	});
});

describe("llms corpus probing stays bounded", () => {
	test("crafted llms.txt body is not classified as corpus", () => {
		const corpusBody = `[a](${"x".repeat(1_000_000)}`;
		timed("llms corpus probe", () => {
			expect(isLlmsCorpus("application/octet-stream", corpusBody)).toBe(false);
		});
	});
});

describe("markdown link scanning stays bounded", () => {
	test("pathological links do not backtrack and normal links survive", () => {
		timed("markdown links", () => {
			expect(markdownLinkHrefs(`${"[".repeat(200_000)}](`)).toHaveLength(0);
			const markdown =
				'Read [API](https://docs.example.com/api "API docs") and [Guide](/guide).';
			expect(markdownLinkHrefs(markdown).join("|")).toBe(
				"https://docs.example.com/api|/guide",
			);
			expect(
				markdownLinkHrefs(String.raw`\[x\](javascript:alert(1))`),
			).toHaveLength(0);
			expect(markdownLinkHrefs("[x](/y)").join("|")).toBe("/y");
			expect(
				replaceMarkdownLinks(markdown, ({ text, href, suffix }) =>
					href === "/guide" ? `[${text}](/local/guide${suffix})` : undefined,
				).endsWith("[Guide](/local/guide)."),
			).toBe(true);
		});
	});
});

describe("html tag stripping stays bounded", () => {
	test("script and style stripping stays linear and refresh parsing ignores noscript", () => {
		timed("html tag stripping", () => {
			expect(stripScriptStyleTags("<script>".repeat(100_000))).toHaveLength(
				800_000,
			);
			const cleaned = stripScriptStyleTags(
				"<main>Keep</main><script>drop()</script><style>.x{}</style>",
			);
			expect(cleaned).toBe("<main>Keep</main>");
			expect(
				refreshUrl({
					ok: true,
					url: "https://docs.example.com/",
					finalUrl: "https://docs.example.com/",
					status: 200,
					contentType: "text/html",
					body: `${"<noscript>".repeat(
						100_000,
					)}<meta http-equiv="refresh" content="0; url=/next">`,
					fetchMs: 1,
				}),
			).toBe("https://docs.example.com/next");
			expect(
				refreshUrl({
					ok: true,
					url: "https://docs.example.com/",
					finalUrl: "https://docs.example.com/",
					status: 200,
					contentType: "text/html",
					body: '<noscript><meta http-equiv="refresh" content="0; url=/fallback"></noscript><meta http-equiv="refresh" content="0; url=/real">',
					fetchMs: 1,
				}),
			).toBe("https://docs.example.com/real");
		});
	});
});

describe("numeric css noise detection stays bounded", () => {
	test("pathological numeric strings stay bounded and useful serialized text survives", () => {
		timed("numeric css noise", () => {
			expect(numericCssNoise(`${"1 ".repeat(200_000)}12px em`)).toBe(false);
			const repeatedCss = `${"1 ".repeat(4_000)}12px em`;
			for (let index = 0; index < 50; index++) {
				expect(numericCssNoise(repeatedCss)).toBe(false);
			}
			expect(numericCssNoise("1 2 3 12px 4 5")).toBe(true);
			expect(numericCssNoise("Install the 12px spacing guide")).toBe(false);
			expect(numericCssNoise("100px 200px")).toBe(true);
			expect(numericCssNoise("0px 0px 100px 200px")).toBe(true);
			const useful =
				"Install the SDK and configure authentication before creating a project with the command line tool. Review the generated Markdown output and verify each captured page before sharing the corpus with coding agents. Retry changed pages during refresh runs and keep the summary updated for later maintenance work.";
			const extracted = extractSerializedText(
				`<script>{"children":"1 2 3 12px 4 5","description":${JSON.stringify(
					useful,
				)},"title":"Docs"}</script>`,
				"Docs",
			);
			expect(extracted?.includes("Install the SDK")).toBe(true);
			expect(extracted?.includes("12px")).toBe(false);
		});
	});
});

describe("robots parsing stays bounded", () => {
	test("hostile robots file parses without overflowing the stack", () => {
		const hostileAgents: string[] = [];
		for (let index = 0; index < 850_000; index++) {
			hostileAgents.push("User-agent: x");
		}
		hostileAgents.push("Disallow: /private");
		const hostileRobots = hostileAgents.join("\n");
		timed("robots parse", () => {
			const robots = parseRobots(
				hostileRobots,
				"https://hostile.example",
				"docsnap",
			);
			expect(typeof robots.allowed).toBe("function");
		});
	});

	test("normal disallow allow and sitemap semantics survive", () => {
		const normalRobots = parseRobots(
			"User-agent: *\nDisallow: /private\nAllow: /private/ok\nSitemap: https://x.example/s.xml",
			"https://x.example",
			"docsnap",
		);
		expect(normalRobots.allowed("https://x.example/private")).toBe(false);
		expect(normalRobots.allowed("https://x.example/private/ok")).toBe(true);
		expect(normalRobots.sitemaps[0]).toBe("https://x.example/s.xml");
	});
});

function timed(name: string, run: () => void): number {
	const started = performance.now();
	run();
	const elapsed = performance.now() - started;
	try {
		expect(elapsed).toBeLessThan(maxMs);
	} catch {
		throw new Error(`${name} took ${elapsed.toFixed(1)}ms`);
	}
	return elapsed;
}
