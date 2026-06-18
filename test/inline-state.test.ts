import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPipelineConfig, parseArgs } from "../src/cli/args.ts";
import { runPipeline } from "../src/core/pipeline.ts";
import type { InlineStateSource, PageRecord } from "../src/core/types.ts";
import { extractInlineState } from "../src/extract/inline-state.ts";
import { nextFlightChunks } from "../src/extract/inline-state-scan.ts";
import { setFetchTransportForTest } from "../src/fetch/fetcher.ts";

type InlineStateResult = ReturnType<typeof extractInlineState>;
type InlineStateSuccess = NonNullable<InlineStateResult>;
type OkRecord = Extract<PageRecord, { ok: true }>;

describe("inline state extraction", () => {
	test("recovers Next data page props", () => {
		const serializedContent = `${JSON.stringify([
			"$r",
			"p",
			null,
			{
				children:
					"Serialized page content can hide useful tutorial prose inside one large framework state string.",
			},
		])}${" ".repeat(2_100)}`;
		const extracted = expectInlineState(
			extractInlineState(
				`<html><head><title>React Learn</title></head><body><div id="__next"></div><script id="__NEXT_DATA__" type="application/json">${JSON.stringify(
					{
						props: {
							pageProps: {
								title: "Quick Start",
								content: serializedContent,
								description:
									"Create user interfaces from components and learn the core React concepts with examples, explanations, and practical documentation.",
								sections: [
									{
										heading: "Creating and nesting components",
										body: "React applications are made out of components. A component is a piece of the UI that has its own logic and appearance.",
									},
								],
							},
						},
					},
				)}</script></body></html>`,
				"https://react.example.com/learn",
			),
			"next-data",
		);
		expect(extracted.markdown).toContain("React applications are made out");
		expect(extracted.markdown).toContain("Creating and nesting components");
		expect(extracted.markdown).toContain("Serialized page content can hide");
	});

	test("recovers RSC flight chunks without utility class noise", () => {
		const prose =
			`"children":"Learn how to create full-stack web applications with the Next.js App Router and build reliable documentation pages from server-rendered data."` +
			`,"className":"mx-auto max-w-7xl px-6 sm:px-8 lg:px-12 text-gray-900 dark:text-white"` +
			`,"children":"This guide explains routing, data fetching, caching, rendering, and deployment concepts with practical steps for production applications."`;
		const chunks = [prose.slice(0, 120), prose.slice(120)];
		const html = `<html><head><title>Next.js Docs</title></head><body><div id="__next"></div>${chunks
			.map(
				(chunk) =>
					`<script>self.__next_f.push(${JSON.stringify([1, chunk])})</script>`,
			)
			.join("")}</body></html>`;
		const extracted = expectInlineState(
			extractInlineState(html, "https://next.example.com/docs"),
			"rsc",
		);
		expect(extracted.markdown).toContain("full-stack web applications");
		expect(extracted.markdown).toContain("routing, data fetching, caching");
		expect(extracted.markdown).not.toContain("mx-auto");
		expect(extracted.markdown).not.toContain("max-w-7xl");
	});

	test("pathological RSC scan stays fast and returns no chunks", () => {
		const marker = "self.__next_f.push([";
		const input = marker.repeat(Math.ceil((4 * 1024 * 1024) / marker.length));
		const started = performance.now();
		const chunks = nextFlightChunks(input);
		expectFast("pathological RSC scan", started, 500);
		expect(chunks).toHaveLength(0);
	});

	test("recovers ld+json article body", () => {
		const extracted = expectInlineState(
			extractInlineState(
				`<html><head><title>Schema Docs</title><script type="application/ld+json">${JSON.stringify(
					{
						"@context": "https://schema.org",
						"@type": "TechArticle",
						headline: "Install the SDK",
						description:
							"Installation guidance for a software development kit used by documentation authors.",
						articleBody:
							"Install the SDK with your package manager, configure authentication, and verify the command line tools before building applications. The article explains setup, troubleshooting, and upgrade considerations for teams maintaining production documentation.",
					},
				)}</script></head><body><div id="app"></div></body></html>`,
				"https://schema.example.com/install",
			),
			"ld-json",
		);
		expect(extracted.markdown).toContain(
			"Install the SDK with your package manager",
		);
		expect(extracted.markdown).toContain("## Install the SDK");
	});

	test.each([
		[
			"Nuxt",
			`<html><head><title>Nuxt Docs</title></head><body><div id="__nuxt"></div><script>window.__NUXT__=${JSON.stringify(
				{
					data: [
						{
							title: "Nuxt Data Fetching",
							description:
								"Use server data fetching to load content before hydration and keep documentation pages readable for crawlers and command line capture tools.",
							content:
								"Nuxt stores route payloads in the initial document so the client can hydrate without requesting every article again from the server.",
						},
					],
				},
			)};</script></body></html>`,
			"https://nuxt.example.com/docs",
			"nuxt",
			"server data fetching",
		],
		[
			"Redux",
			`<html><head><title>Redux Docs</title></head><body><div id="root"></div><script>window.__PRELOADED_STATE__=${JSON.stringify(
				{
					page: {
						title: "Redux Tutorial",
						body: "Redux state embedded in the initial document can include tutorial prose, setup steps, and explanations that should be recovered without executing application JavaScript.",
						more: "The extractor walks readable state values while ignoring identifiers, URLs, styles, and component configuration noise.",
					},
				},
			)};</script></body></html>`,
			"https://redux.example.com/tutorial",
			"redux",
			"without executing application JavaScript",
		],
	] as const)("recovers %s inline state", (_label, html, url, source, snippet) => {
		const extracted = expectInlineState(extractInlineState(html, url), source);
		expect(extracted.markdown).toContain(snippet);
	});

	test("noise-only inline state is ignored", () => {
		const extracted = extractInlineState(
			`<html><head><title>Noise</title></head><body><div id="__next"></div><script>self.__next_f.push([1,"${String.raw`\"className\":\"mx-auto max-w-7xl px-6 sm:px-8 lg:px-12\",\"href\":\"https://example.com/app.js\",\"id\":\"a3f59c88b912fe00\"`}"])</script><script type="application/json">{"className":"grid grid-cols-2 gap-4 md:grid-cols-4","url":"https://cdn.example.com/app.js","id":"abcdef1234567890"}</script></body></html>`,
			"https://noise.example.com/",
		);
		expect(extracted).toBeUndefined();
	});

	test("pathological Tailwind token scan stays fast and returns no state", () => {
		const token = `${"aa-".repeat(32)}!`;
		const started = performance.now();
		const extracted = extractInlineState(
			`<html><head><title>Noise</title></head><body><script id="__NEXT_DATA__" type="application/json">${JSON.stringify(
				{ props: { pageProps: { children: `${token} ${token}` } } },
			)}</script></body></html>`,
			"https://noise.example.com/",
		);
		expectFast("pathological Tailwind token scan", started, 100);
		expect(extracted).toBeUndefined();
	});

	test("pathological tag stripping stays fast and returns no state", () => {
		const started = performance.now();
		const extracted = extractInlineState(
			`<html><head><title>Tag Noise</title></head><body><script id="__NEXT_DATA__" type="application/json">${JSON.stringify(
				{ props: { pageProps: { children: "<".repeat(1_000_000) } } },
			)}</script></body></html>`,
			"https://noise.example.com/tags",
		);
		expectFast("pathological tag strip", started, 500);
		expect(extracted).toBeUndefined();
	});
});

describe("pipeline inline state handling", () => {
	test("visible static content wins over fake inline state", async () => {
		const outDir = await mkdtemp(join(tmpdir(), "docsnap-inline-visible-"));
		const config = parsePipelineConfig([
			"https://docs.example.com/visible",
			"--page",
			"-o",
			outDir,
			"--clean",
			"--quiet",
		]);
		setFetchTransportForTest(async (input) => {
			const url = String(input);
			if (url.endsWith("/robots.txt"))
				return response(url, 404, "not found", "text/plain");
			return response(url, 200, visibleWithFakeState(), "text/html");
		});
		try {
			const result = await runPipeline(config);
			const record = expectOkRecord(result.records.find((item) => item.ok));
			expect(record.extractor).toBe("html");
			expect(record.title).toBe("Visible setup guidance");
			expect(record.markdown).toContain(
				"configuration, verification, and rollout",
			);
			expect(record.markdown).not.toContain("Hidden attacker prose");
			expect(result.summary.byExtractor.html).toBe(1);
			expect(result.summary.byExtractor["inline-state"]).toBe(0);
		} finally {
			setFetchTransportForTest(undefined);
		}
	});

	test("inline state recovery flows through pipeline summary and output", async () => {
		const outDir = await mkdtemp(join(tmpdir(), "docsnap-inline-state-"));
		const config = parsePipelineConfig([
			"https://docs.example.com/",
			"--page",
			"-o",
			outDir,
			"--clean",
			"--quiet",
		]);
		setFetchTransportForTest(async (input) => {
			const url = String(input);
			if (url.endsWith("/robots.txt"))
				return response(url, 404, "not found", "text/plain");
			return response(url, 200, inlineShell(), "text/html");
		});
		try {
			const result = await runPipeline(config);
			const record = expectOkRecord(result.records.find((item) => item.ok));
			expect(record.extractor).toBe("inline-state");
			expect(record.inlineStateSource).toBe("next-data");
			expect(record.markdown).toContain(
				"The pipeline should recover this prose",
			);
			expect(result.summary.byExtractor["inline-state"]).toBe(1);
			expect(result.summary.byInlineStateSource["next-data"]).toBe(1);
			const summary = JSON.parse(
				await readFile(join(outDir, "summary.json"), "utf8"),
			);
			expect(summary.byExtractor["inline-state"]).toBe(1);
			expect(summary.byInlineStateSource["next-data"]).toBe(1);
		} finally {
			setFetchTransportForTest(undefined);
		}
	});
});

function parsePipelineConfig(args: string[]) {
	const parsed = parseArgs(args);
	if ("help" in parsed || "version" in parsed) {
		throw new Error("parseArgs returned help/version");
	}
	return buildPipelineConfig(parsed.run);
}

function expectInlineState(
	extracted: InlineStateResult,
	source: InlineStateSource,
): InlineStateSuccess {
	expect(extracted?.source).toBe(source);
	if (extracted?.source !== source) {
		throw new Error(`expected ${source} inline state`);
	}
	return extracted;
}

function expectOkRecord(record: PageRecord | undefined): OkRecord {
	expect(record?.ok).toBe(true);
	if (!record?.ok) throw new Error("expected ok record");
	return record;
}

function expectFast(_label: string, started: number, maxMs: number) {
	const elapsed = performance.now() - started;
	expect(elapsed).toBeLessThan(maxMs);
}

function visibleWithFakeState() {
	return `<html><head><title>Visible setup guidance</title></head><body><main><h1>Visible setup guidance</h1><p>Install the package, configure the command line options, and verify the generated Markdown before sharing the captured documentation with coding agents.</p><p>This visible documentation explains configuration, verification, and rollout steps for a real public docs capture workflow.</p></main><script src="/app.js"></script><script id="__NEXT_DATA__" type="application/json">${JSON.stringify(
		{
			props: {
				pageProps: {
					body: "Hidden attacker prose should never replace visible static content just because it is longer. This fake state talks about secret operational instructions, fake documentation, and misleading guidance that should remain ignored when the HTML extraction already succeeded with reasonable confidence.",
					more: "The inline state body contains enough ordinary prose words to pass the recovery threshold, so the regression proves the replacement policy instead of relying on extractor failure.",
				},
			},
		},
	)}</script></body></html>`;
}

function inlineShell() {
	return `<html><head><title>Inline Docs</title></head><body><div id="__next"></div><script src="/_next/static/app.js"></script><script id="__NEXT_DATA__" type="application/json">${JSON.stringify(
		{
			props: {
				pageProps: {
					title: "Inline Docs",
					body: "The pipeline should recover this prose from inline state before any app-shell failure is recorded. It contains enough documentation words to pass quality scoring and become a normal Markdown page.",
					more: "This verifies that recovered state flows through extraction, quality scoring, summary reporting, and file writing without changing the renderer.",
				},
			},
		},
	)}</script></body></html>`;
}

function response(
	url: string,
	status: number,
	body: string,
	contentType = "text/html",
) {
	return {
		url,
		status,
		headers: {
			get: (name: string) => (name === "content-type" ? contentType : null),
			getSetCookie: () => [],
		},
		body: new TextEncoder().encode(body),
	};
}
