import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "../src/cli/args.ts";
import { runPipeline } from "../src/core/pipeline.ts";
import { extractInlineState } from "../src/extract/inline-state.ts";
import { nextFlightChunks } from "../src/extract/inline-state-scan.ts";
import { setFetchTransportForTest } from "../src/fetch/fetcher.ts";

nextDataRegression();
rscRegression();
rscPathologicalRegression();
ldJsonRegression();
nuxtAndReduxRegression();
noiseOnlyRegression();
tailwindPathologicalRegression();
tagStripPathologicalRegression();
await visibleStaticContentWinsRegression();
await pipelineRegression();

function nextDataRegression() {
	const serializedContent = `${JSON.stringify([
		"$r",
		"p",
		null,
		{
			children:
				"Serialized page content can hide useful tutorial prose inside one large framework state string.",
		},
	])}${" ".repeat(2_100)}`;
	const extracted = extractInlineState(
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
	);
	assert(extracted?.source === "next-data");
	assert(extracted.markdown.includes("React applications are made out"));
	assert(extracted.markdown.includes("Creating and nesting components"));
	assert(extracted.markdown.includes("Serialized page content can hide"));
}

function rscRegression() {
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
	const extracted = extractInlineState(html, "https://next.example.com/docs");
	assert(extracted?.source === "rsc");
	assert(extracted.markdown.includes("full-stack web applications"));
	assert(extracted.markdown.includes("routing, data fetching, caching"));
	assert(!extracted.markdown.includes("mx-auto"));
	assert(!extracted.markdown.includes("max-w-7xl"));
}

function rscPathologicalRegression() {
	const marker = "self.__next_f.push([";
	const input = marker.repeat(Math.ceil((4 * 1024 * 1024) / marker.length));
	const started = performance.now();
	const chunks = nextFlightChunks(input);
	assertFast("pathological RSC scan", started, 500);
	assert(chunks.length === 0);
}

function ldJsonRegression() {
	const extracted = extractInlineState(
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
	);
	assert(extracted?.source === "ld-json");
	assert(
		extracted.markdown.includes("Install the SDK with your package manager"),
	);
	assert(extracted.markdown.includes("## Install the SDK"));
}

function nuxtAndReduxRegression() {
	const nuxt = extractInlineState(
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
	);
	assert(nuxt?.source === "nuxt");
	assert(nuxt.markdown.includes("server data fetching"));

	const redux = extractInlineState(
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
	);
	assert(redux?.source === "redux");
	assert(redux.markdown.includes("without executing application JavaScript"));
}

function noiseOnlyRegression() {
	const extracted = extractInlineState(
		`<html><head><title>Noise</title></head><body><div id="__next"></div><script>self.__next_f.push([1,"${String.raw`\"className\":\"mx-auto max-w-7xl px-6 sm:px-8 lg:px-12\",\"href\":\"https://example.com/app.js\",\"id\":\"a3f59c88b912fe00\"`}"])</script><script type="application/json">{"className":"grid grid-cols-2 gap-4 md:grid-cols-4","url":"https://cdn.example.com/app.js","id":"abcdef1234567890"}</script></body></html>`,
		"https://noise.example.com/",
	);
	assert(extracted === undefined);
}

function tailwindPathologicalRegression() {
	const token = `${"aa-".repeat(32)}!`;
	const started = performance.now();
	const extracted = extractInlineState(
		`<html><head><title>Noise</title></head><body><script id="__NEXT_DATA__" type="application/json">${JSON.stringify(
			{ props: { pageProps: { children: `${token} ${token}` } } },
		)}</script></body></html>`,
		"https://noise.example.com/",
	);
	assertFast("pathological Tailwind token scan", started, 100);
	assert(extracted === undefined);
}

function tagStripPathologicalRegression() {
	const started = performance.now();
	const extracted = extractInlineState(
		`<html><head><title>Tag Noise</title></head><body><script id="__NEXT_DATA__" type="application/json">${JSON.stringify(
			{ props: { pageProps: { children: "<".repeat(1_000_000) } } },
		)}</script></body></html>`,
		"https://noise.example.com/tags",
	);
	assertFast("pathological tag strip", started, 500);
	assert(extracted === undefined);
}

async function visibleStaticContentWinsRegression() {
	const outDir = await mkdtemp(join(tmpdir(), "docsnap-inline-visible-"));
	const config = parseArgs([
		"https://docs.example.com/visible",
		"--page",
		"-o",
		outDir,
		"--clean",
		"--quiet",
	]);
	assert(!("help" in config) && !("version" in config));
	setFetchTransportForTest(async (input) => {
		const url = String(input);
		if (url.endsWith("/robots.txt"))
			return response(url, 404, "not found", "text/plain");
		return response(url, 200, visibleWithFakeState(), "text/html");
	});
	try {
		const result = await runPipeline(config);
		const record = result.records.find((item) => item.ok);
		assert(record?.ok);
		assert(record.extractor === "html");
		assert(record.title === "Visible setup guidance");
		assert(
			record.markdown.includes("configuration, verification, and rollout"),
		);
		assert(!record.markdown.includes("Hidden attacker prose"));
		assert(result.summary.byExtractor.html === 1);
		assert(result.summary.byExtractor["inline-state"] === 0);
		assert(result.summary.render.attempted === 1);
		assert(record.render?.error?.startsWith("render_miss:"));
	} finally {
		setFetchTransportForTest(undefined);
	}
}

async function pipelineRegression() {
	const outDir = await mkdtemp(join(tmpdir(), "docsnap-inline-state-"));
	const config = parseArgs([
		"https://docs.example.com/",
		"--page",
		"-o",
		outDir,
		"--clean",
		"--quiet",
	]);
	assert(!("help" in config) && !("version" in config));
	setFetchTransportForTest(async (input) => {
		const url = String(input);
		if (url.endsWith("/robots.txt"))
			return response(url, 404, "not found", "text/plain");
		return response(url, 200, inlineShell(), "text/html");
	});
	try {
		const result = await runPipeline(config);
		const record = result.records.find((item) => item.ok);
		assert(record?.ok);
		assert(record.extractor === "inline-state");
		assert(record.inlineStateSource === "next-data");
		assert(record.markdown.includes("The pipeline should recover this prose"));
		assert(result.summary.render.attempted === 0);
		assert(result.summary.byExtractor["inline-state"] === 1);
		assert(result.summary.byInlineStateSource["next-data"] === 1);
		const summary = JSON.parse(
			await readFile(join(outDir, "summary.json"), "utf8"),
		);
		assert(summary.byExtractor["inline-state"] === 1);
		assert(summary.byInlineStateSource["next-data"] === 1);
	} finally {
		setFetchTransportForTest(undefined);
	}
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
					body: "The pipeline should recover this prose from inline state before browser rendering. It contains enough documentation words to pass quality scoring and become a normal Markdown page.",
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

function assert(condition: unknown): asserts condition {
	if (!condition) throw new Error("assertion failed");
}

function assertFast(label: string, started: number, maxMs: number) {
	const elapsed = performance.now() - started;
	if (elapsed > maxMs) {
		throw new Error(
			`${label} took ${Math.round(elapsed)}ms, expected <${maxMs}ms`,
		);
	}
}
