import { onTestFinished } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hashContent, snapshotStats } from "../src/core/snapshot.ts";
import type {
	FetchResult,
	PageOutput,
	PathedPage,
	PipelineConfig,
	RunRecord,
	RunSummary,
} from "../src/core/types.ts";
import { renderPage } from "../src/output/page.ts";
import {
	commitStagedOutput,
	discardStagedOutput,
	stagePages,
} from "../src/output/writer.ts";
import { buildSummary } from "../src/report/summary.ts";

type OkFetchResult = Extract<FetchResult, { ok: true; notModified?: false }>;

export async function tempDir(label: string): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), `docsnap-${label}-`));
	onTestFinished(() => rm(root, { recursive: true, force: true }));
	return root;
}

export function setTestEnv(name: string, value: string) {
	const prior = process.env[name];
	process.env[name] = value;
	onTestFinished(() => {
		if (prior === undefined) delete process.env[name];
		else process.env[name] = prior;
	});
}

export function testConfig(
	outDir: string,
	overrides: Partial<PipelineConfig> = {},
): PipelineConfig {
	return {
		seedUrl: "https://docs.example.com/guide",
		outDir,
		max: 1,
		maxExplicit: true,
		concurrency: 1,
		perOrigin: 1,
		clean: false,
		dryRun: false,
		pageOnly: true,
		cache: false,
		userAgent: "docsnap-test/0.2",
		timeoutMs: 1_000,
		maxBytes: 1024 * 1024,
		...overrides,
	};
}

export function okFetch(
	url: string,
	body: string,
	overrides: Partial<Omit<OkFetchResult, "ok">> = {},
): FetchResult {
	return {
		ok: true,
		url,
		finalUrl: url,
		status: 200,
		contentType: "text/html",
		body,
		fetchMs: 1,
		redirects: [],
		fetchedAt: "2026-01-01T00:00:00.000Z",
		...overrides,
	};
}

export function testPage(
	markdown = "# Guide\n\nHash-verified documentation content.",
): PageOutput {
	const base: PathedPage = {
		ok: true as const,
		url: "https://docs.example.com/guide",
		finalUrl: "https://docs.example.com/guide",
		status: 200,
		source: "seed" as const,
		wasSeed: true as const,
		timings: { fetchMs: 1, extractMs: 1, writeMs: 0 },
		redirects: [],
		fetchedAt: "2026-01-01T00:00:00.000Z",
		injectionSignals: [],
		title: "Guide",
		markdown,
		links: [],
		contentHash: hashContent(markdown),
		extractor: "markdown" as const,
		confidence: 1,
		qualityReasons: [],
		outputPath: "guide.md",
	};
	const rendered = renderPage(base);
	return { ...base, rendered, outputHash: hashContent(rendered) };
}

export async function writeRunMetadata(
	records: RunRecord[],
	summary: RunSummary,
	config: PipelineConfig,
) {
	await commitRun([], records, summary, config);
}

export async function writeValidCorpus(outputDir: string) {
	const page = testPage();
	const snapshot = snapshotStats([
		{ path: page.outputPath, body: page.rendered },
	]);
	const config = testConfig(outputDir);
	const summary = buildSummary(
		[page],
		[page],
		config,
		[{ url: page.url, source: "seed", wasSeed: true }],
		0,
		snapshot,
		1,
	);
	await commitRun([page], [page], summary, config);
	return { config, page, summary };
}

export async function commitRun(
	pages: PageOutput[],
	records: RunRecord[],
	summary: RunSummary,
	config: PipelineConfig,
) {
	const staged = await stagePages(pages, config);
	try {
		await commitStagedOutput(staged, records, summary, config);
	} finally {
		await discardStagedOutput(staged);
	}
}
