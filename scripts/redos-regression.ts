import {
	markdownLinkHrefs,
	replaceMarkdownLinks,
} from "../src/core/markdown.ts";
import { stripScriptStyleTags } from "../src/extract/html.ts";
import {
	extractSerializedText,
	numericCssNoise,
} from "../src/extract/scripts.ts";
import { refreshUrl } from "../src/fetch/refresh.ts";

const maxMs = 200;

const markdownMs = timed("markdown links", () => {
	assert(markdownLinkHrefs(`${"[".repeat(200_000)}](`).length === 0);
	const markdown =
		'Read [API](https://docs.example.com/api "API docs") and [Guide](/guide).';
	assert(
		markdownLinkHrefs(markdown).join("|") ===
			"https://docs.example.com/api|/guide",
	);
	assert(
		markdownLinkHrefs(String.raw`\[x\](javascript:alert(1))`).length === 0,
	);
	assert(markdownLinkHrefs("[x](/y)").join("|") === "/y");
	assert(
		replaceMarkdownLinks(markdown, ({ text, href, suffix }) =>
			href === "/guide" ? `[${text}](/local/guide${suffix})` : undefined,
		).endsWith("[Guide](/local/guide)."),
	);
});

const tagMs = timed("html tag stripping", () => {
	assert(stripScriptStyleTags("<script>".repeat(100_000)).length === 800_000);
	const cleaned = stripScriptStyleTags(
		"<main>Keep</main><script>drop()</script><style>.x{}</style>",
	);
	assert(cleaned === "<main>Keep</main>");
	assert(
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
		}) === "https://docs.example.com/next",
	);
	assert(
		refreshUrl({
			ok: true,
			url: "https://docs.example.com/",
			finalUrl: "https://docs.example.com/",
			status: 200,
			contentType: "text/html",
			body: '<noscript><meta http-equiv="refresh" content="0; url=/fallback"></noscript><meta http-equiv="refresh" content="0; url=/real">',
			fetchMs: 1,
		}) === "https://docs.example.com/real",
	);
});

const cssMs = timed("numeric css noise", () => {
	assert(numericCssNoise(`${"1 ".repeat(200_000)}12px em`) === false);
	const repeatedCss = `${"1 ".repeat(4_000)}12px em`;
	for (let index = 0; index < 50; index++) {
		assert(numericCssNoise(repeatedCss) === false);
	}
	assert(numericCssNoise("1 2 3 12px 4 5"));
	assert(!numericCssNoise("Install the 12px spacing guide"));
	const useful =
		"Install the SDK and configure authentication before creating a project with the command line tool. Review the generated Markdown output and verify each captured page before sharing the corpus with coding agents. Retry changed pages during refresh runs and keep the summary updated for later maintenance work.";
	const extracted = extractSerializedText(
		`<script>{"children":"1 2 3 12px 4 5","description":${JSON.stringify(
			useful,
		)},"title":"Docs"}</script>`,
		"Docs",
	);
	assert(extracted?.includes("Install the SDK"));
	assert(!extracted?.includes("12px"));
});

console.log(
	`redos regression passed: markdown=${markdownMs.toFixed(
		1,
	)}ms tags=${tagMs.toFixed(1)}ms css=${cssMs.toFixed(1)}ms`,
);

function timed(name: string, run: () => void): number {
	const started = performance.now();
	run();
	const elapsed = performance.now() - started;
	assert(elapsed < maxMs, `${name} took ${elapsed.toFixed(1)}ms`);
	return elapsed;
}

function assert(
	condition: unknown,
	message = "assertion failed",
): asserts condition {
	if (!condition) throw new Error(message);
}
