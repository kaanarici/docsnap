import { describe, expect, test } from "bun:test";
import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { buildRefreshConfig } from "../src/core/config.ts";
import { runFiles } from "../src/output/files.ts";
import { conditionalRequestForPrior, loadPrior } from "../src/output/prior.ts";
import { corpusLimits } from "../src/output/read.ts";
import { buildSummary, readRefreshSummary } from "../src/report/summary.ts";
import {
	tempDir,
	testConfig,
	testFailure,
	testPage,
	writeRunMetadata,
	writeValidCorpus,
} from "./fixtures.ts";

describe("corpus integrity", () => {
	test("keeps page frontmatter limited to source metadata", () => {
		const page = testPage();
		expect(page.rendered).toContain('url: "https://docs.example.com/guide"');
		expect(page.rendered).not.toContain("contentHash:");
		expect(page.rendered).not.toContain("fetchedAt:");
		expect(page.rendered).not.toContain("extractor:");
		expect(page.rendered).not.toContain("redirects:");
	});

	test("bounds summary failure examples", () => {
		const failures = Array.from({ length: 25 }, (_, index) =>
			testFailure({
				url: `https://docs.example.com/${index}`,
				finalUrl: `https://docs.example.com/${index}`,
				status: 429,
				error: "HTTP 429",
				failureKind: "blocked",
			}),
		);
		const summary = buildSummary(
			failures,
			[],
			testConfig("unused", { pageOnly: false, max: 25 }),
		);
		expect(summary.errors).toHaveLength(3);
		expect(summary.errorsOmitted).toBe(22);
	});

	test("keeps a successfully redirected seed successful", () => {
		const seedUrl = "https://docs.example.com/start";
		const finalUrl = "https://docs.example.com/guide";
		const page = {
			...testPage(),
			url: seedUrl,
			finalUrl,
			redirects: [
				{ from: seedUrl, to: finalUrl, type: "http" as const, status: 301 },
			],
		};
		const summary = buildSummary(
			[page],
			[page],
			testConfig("unused", { seedUrl }),
		);
		expect(summary.ok).toBe(true);
		expect(summary.seed).toMatchObject({
			included: true,
			redirected: true,
			url: seedUrl,
			finalUrl,
		});
	});

	test("keeps manifest resource indexes public", async () => {
		const root = await tempDir("manifest-public-urls");
		const { summary } = await writeValidCorpus(root);
		const page = {
			...testPage(),
			links: ["https://docs.example.com/public", "http://localhost:3000/"],
		};
		await writeRunMetadata([page], summary, testConfig(root));
		const entry = JSON.parse(
			(await readFile(join(root, runFiles.manifest), "utf8")).trim(),
		);
		expect(entry.links).toEqual(["https://docs.example.com/public"]);
	});

	test("refetches pages whose persisted discovery links were truncated", async () => {
		const root = await tempDir("prior-truncated-links");
		const links = Array.from(
			{ length: 500 },
			(_, index) => `https://docs.example.com/${index}/${"x".repeat(80)}`,
		);
		const page = { ...testPage(), etag: '"v1"', links };
		const config = testConfig(root);
		const summary = buildSummary([page], [page], config);
		await writeRunMetadata([page], summary, config);
		const prior = await loadPrior(config);
		expect(prior.enabled).toBe(true);
		expect(
			conditionalRequestForPrior(prior, { url: page.url }),
		).toBeUndefined();
	});

	test("keeps maximum-run manifests inside the read limit", async () => {
		const root = await tempDir("manifest-limit");
		const links = Array.from(
			{ length: 160 },
			(_, index) => `https://docs.example.com/${index}/${"x".repeat(80)}`,
		);
		const records = Array.from({ length: 2_000 }, (_, index) => ({
			...testPage(),
			url: `https://docs.example.com/${index}`,
			finalUrl: `https://docs.example.com/${index}`,
			outputPath: `${index}.md`,
			links,
		}));
		const { summary } = await writeValidCorpus(root);
		await writeRunMetadata(records, summary, testConfig(root, { max: 2_000 }));
		expect(
			(await stat(join(root, runFiles.manifest))).size,
		).toBeLessThanOrEqual(corpusLimits.manifestBytes);
		const entry = JSON.parse(
			(await readFile(join(root, runFiles.manifest), "utf8")).split("\n")[0] ??
				"{}",
		);
		expect(entry).toMatchObject({
			linksCount: links.length,
			linksTruncated: true,
		});
	});

	test("bounds prior metadata before parsing", async () => {
		const root = await tempDir("prior-summary-limit");
		const { config } = await writeValidCorpus(root);
		await writeFile(
			join(root, runFiles.summary),
			"x".repeat(corpusLimits.summaryBytes + 1),
		);
		await expect(loadPrior(config)).resolves.toMatchObject({
			enabled: false,
			reason: "invalid_manifest",
		});
	});

	test("does not reuse a corpus captured from a different seed", async () => {
		const root = await tempDir("prior-seed-mismatch");
		const { summary } = await writeValidCorpus(root);
		await expect(
			loadPrior(
				testConfig(root, { seedUrl: "https://docs.example.com/other" }),
			),
		).resolves.toMatchObject({
			enabled: false,
			reason: "seed_mismatch",
			seedUrl: summary.seedUrl,
		});
	});

	test("reads only the fields refresh needs", async () => {
		const root = await tempDir("refresh-summary");
		const { summary } = await writeValidCorpus(root);
		summary.include = ["/docs/**"];
		summary.exclude = ["/docs/internal/**"];
		await writeFile(join(root, runFiles.summary), JSON.stringify(summary));
		const prior = await readRefreshSummary(root);
		expect(prior).toEqual({
			seedUrl: summary.seedUrl,
			max: summary.max,
			maxAppliesTo: summary.maxAppliesTo,
			captureMode: summary.captureMode,
			userAgent: summary.userAgent,
			include: ["/docs/**"],
			exclude: ["/docs/internal/**"],
		});
		expect(
			buildRefreshConfig(prior, { outDir: root, max: undefined, cache: true }),
		).toMatchObject({
			include: ["/docs/**"],
			exclude: ["/docs/internal/**"],
		});
	});

	test("rejects invalid refresh metadata", async () => {
		const root = await tempDir("refresh-summary-invalid");
		const { summary } = await writeValidCorpus(root);
		await writeFile(
			join(root, runFiles.summary),
			JSON.stringify({ ...summary, max: 2_001 }),
		);
		await expect(readRefreshSummary(root)).rejects.toThrow(
			"Invalid summary.json in corpus",
		);
	});
});
