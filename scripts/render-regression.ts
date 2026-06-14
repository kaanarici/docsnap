import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "../src/cli/args.ts";
import { runPipeline } from "../src/core/pipeline.ts";
import type { Config, FetchedUrl } from "../src/core/types.ts";
import { setFetchTransportForTest } from "../src/fetch/fetcher.ts";
import {
	createRenderState,
	RENDER_MISS_REASON,
	renderCandidates,
} from "../src/render/index.ts";

await cliArgsRegression();
await renderMissPipelineRegression();
await renderNeverRegression();
await inlineStatePreventsRenderMissRegression();
await renderLimitRegression();

function cliArgsRegression() {
	const config = parsedConfig([
		"https://docs.example.com/",
		"--render",
		"always",
	]);
	assert(config.render === "always");
	assert(parseThrows(["https://docs.example.com/", "--render", "sometimes"]));
}

async function renderMissPipelineRegression() {
	const outDir = await mkdtemp(join(tmpdir(), "docsnap-render-miss-"));
	const config = parsedConfig([
		"https://docs.example.com/",
		"--page",
		"-o",
		outDir,
		"--clean",
		"--quiet",
	]);
	const result = await withTransport(appShellTransport, () =>
		runPipeline(config),
	);
	assert(result.summary.render.renderer === "none");
	assert(result.summary.render.attempted === 1);
	assert(result.summary.render.renderedPages === 0);
	assert(result.summary.render.failedPages === 1);
	assert(result.summary.render.unavailableReason === RENDER_MISS_REASON);
	assert(result.summary.render.pages[0]?.reason === "empty-app-shell");
	assert(
		result.summary.render.pages[0]?.error ===
			`render_miss: ${RENDER_MISS_REASON}`,
	);
	const record = result.records.find((item) => item.url === config.seedUrl);
	assert(record?.render?.renderer === "none");
	assert(record.render.error === `render_miss: ${RENDER_MISS_REASON}`);
	const summary = JSON.parse(
		await readFile(join(outDir, "summary.json"), "utf8"),
	);
	assert(summary.render.unavailableReason === RENDER_MISS_REASON);
}

async function renderNeverRegression() {
	const outDir = await mkdtemp(join(tmpdir(), "docsnap-render-never-"));
	const config = parsedConfig([
		"https://docs.example.com/",
		"--page",
		"--render",
		"never",
		"-o",
		outDir,
		"--clean",
		"--quiet",
	]);
	const result = await withTransport(appShellTransport, () =>
		runPipeline(config),
	);
	assert(result.summary.render.attempted === 0);
	assert(result.summary.render.unavailableReason === null);
	assert(!result.records.some((record) => record.render));
}

async function inlineStatePreventsRenderMissRegression() {
	const outDir = await mkdtemp(join(tmpdir(), "docsnap-render-inline-"));
	const config = parsedConfig([
		"https://docs.example.com/",
		"--page",
		"-o",
		outDir,
		"--clean",
		"--quiet",
	]);
	const result = await withTransport(inlineShellTransport, () =>
		runPipeline(config),
	);
	const record = result.records.find((item) => item.ok);
	assert(record?.ok);
	assert(record.extractor === "inline-state");
	assert(record.inlineStateSource === "next-data");
	assert(result.summary.render.attempted === 0);
}

async function renderLimitRegression() {
	const config = parsedConfig([
		"https://docs.example.com/",
		"-m",
		"2",
		"--render",
		"always",
	]);
	const state = createRenderState(config);
	const attempts = await renderCandidates(
		[fixtureCandidate("/a"), fixtureCandidate("/b"), fixtureCandidate("/c")],
		config,
		state,
	);
	assert(attempts.length === 2);
	assert(state.summary.attempted === 2);
	assert(state.summary.failedPages === 2);
	assert(state.summary.renderedPages === 0);
}

async function withTransport<T>(
	transport: Parameters<typeof setFetchTransportForTest>[0],
	fn: () => Promise<T>,
) {
	setFetchTransportForTest(transport);
	try {
		return await fn();
	} finally {
		setFetchTransportForTest(undefined);
	}
}

async function appShellTransport(input: string | URL | Request) {
	const url = String(input);
	if (url.endsWith("/llms.txt") || url.endsWith("/robots.txt")) {
		return response(url, 404, "not found", "text/plain");
	}
	return response(
		url,
		200,
		`<html><body><div id="app"></div><script src="/app.js"></script></body></html>`,
	);
}

async function inlineShellTransport(input: string | URL | Request) {
	const url = String(input);
	if (url.endsWith("/llms.txt") || url.endsWith("/robots.txt")) {
		return response(url, 404, "not found", "text/plain");
	}
	return response(
		url,
		200,
		`<html><head><title>Inline Docs</title></head><body><div id="__next"></div><script src="/_next/static/app.js"></script><script id="__NEXT_DATA__" type="application/json">${JSON.stringify(
			{
				props: {
					pageProps: {
						title: "Inline Docs",
						body: "Inline state carries readable documentation prose before any browser render miss should be recorded. It explains installation, configuration, troubleshooting, and verification steps for teams capturing public docs into Markdown.",
						more: "The recovered page has enough stable prose for extraction, scoring, summary counts, and Markdown output. It should win before the removed browser renderer has any chance to record a miss for this app shell.",
						steps: [
							"Install the package with the command line tool and choose an output directory for the captured corpus.",
							"Run the capture against a public documentation URL, then inspect summary.json and manifest.jsonl for failures.",
							"Use the generated Markdown as reference material for coding agents after checking source URLs and quality warnings.",
						],
					},
				},
			},
		)}</script></body></html>`,
	);
}

function fixtureCandidate(path: string) {
	const url = `https://docs.example.com${path}`;
	return {
		reason: "always",
		input: {
			source: "seed",
			result: {
				url,
				finalUrl: url,
				status: 200,
				contentType: "text/html",
				body: "<html></html>",
				fetchMs: 0,
				ok: true,
			},
		},
	} satisfies { reason: "always"; input: FetchedUrl };
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
			get: (name: string) =>
				name.toLowerCase() === "content-type" ? contentType : null,
			getSetCookie: () => [],
		},
		body: new TextEncoder().encode(body),
	};
}

function parsedConfig(argv: string[]): Config {
	const config = parseArgs(argv);
	assert(!("help" in config) && !("version" in config));
	return config;
}

function parseThrows(argv: string[]) {
	try {
		parseArgs(argv);
		return false;
	} catch {
		return true;
	}
}

function assert(condition: unknown): asserts condition {
	if (!condition) throw new Error("assertion failed");
}
