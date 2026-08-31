import { describe, expect, test } from "bun:test";
import { mkdir, readdir, readFile, symlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { resolveSafeRelativePath } from "../src/core/fs-safety.ts";
import { partitionPageOutputs } from "../src/core/pipeline.ts";
import { runFiles } from "../src/output/files.ts";
import { corpusLimits } from "../src/output/read.ts";
import { discardStagedOutput, stagePages } from "../src/output/writer.ts";
import { buildSummary } from "../src/report/summary.ts";
import {
	commitRun,
	tempDir,
	testConfig,
	testPage,
	writeValidCorpus,
} from "./fixtures.ts";

async function transactionFiles(root: string) {
	const local = (await readdir(root)).filter(
		(entry) => entry.includes(".tmp") || entry.includes(".backup"),
	);
	const name = basename(root);
	const siblings = (await readdir(dirname(root))).filter(
		(entry) =>
			entry.startsWith(`.${name}.docsnap-stage-`) ||
			entry.startsWith(`${name}.backup-`),
	);
	return [...local, ...siblings];
}

describe("output containment", () => {
	test("reports unchanged page files as skipped writes", async () => {
		const root = await tempDir("unchanged-write");
		const page = testPage();
		await writeFile(join(root, page.outputPath), page.rendered);
		const staged = await stagePages([page], testConfig(root));
		expect(staged.skippedWrites).toBe(1);
		await discardStagedOutput(staged);
	});

	test.each([
		"../escape.md",
		"/tmp/escape.md",
		"C:\\escape.md",
		"..\\escape.md",
	])("rejects unsafe relative path: %s", async (path) => {
		const root = await tempDir("relative-path");
		expect(resolveSafeRelativePath(root, path)).toBeUndefined();
	});

	test("detects and refuses a symlinked parent outside the output root", async () => {
		const root = await tempDir("symlink-root");
		const outside = await tempDir("symlink-outside");
		await mkdir(root, { recursive: true });
		await symlink(outside, join(root, "linked"));
		await expect(
			stagePages(
				[{ ...testPage(), outputPath: "linked/page.md" }],
				testConfig(root),
			),
		).rejects.toThrow("outside output directory");
	});

	test("rejects oversized pages before creating output files", async () => {
		const root = await tempDir("page-limit");
		await expect(
			stagePages(
				[
					{
						...testPage(),
						rendered: "x".repeat(corpusLimits.pageBytes + 1),
					},
				],
				testConfig(root),
			),
		).rejects.toThrow("Page output exceeds the supported size");
		expect(await readdir(root)).toEqual([]);
	});

	test("commits good pages while recording oversized pages as too_large", async () => {
		const root = await tempDir("mixed-page-limit");
		const config = testConfig(root, { max: 2 });
		const good = testPage();
		const largeOutput = {
			...testPage("# Large\n\nFetched content."),
			url: "https://docs.example.com/large",
			finalUrl: "https://docs.example.com/large",
			outputPath: "large.md",
			rendered: "x".repeat(corpusLimits.pageBytes + 1),
		};
		const { outputPath: _path, rendered: _rendered, ...large } = largeOutput;
		const limited = partitionPageOutputs(
			[good, large],
			[good, large],
			[good, largeOutput],
		);
		expect(limited.outputs).toEqual([good]);
		expect(limited.records[1]).toMatchObject({
			ok: false,
			failureKind: "too_large",
		});
		const summary = buildSummary(limited.records, limited.outputs, config);
		const failure = limited.records.find((record) => !record.ok);
		if (!failure || failure.ok) throw new Error("expected oversized failure");
		const runRecords = [good, failure];
		await commitRun(limited.outputs, runRecords, summary, config);
		const records = (await readFile(join(root, runFiles.manifest), "utf8"))
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		expect(records.filter((record) => record.ok)).toHaveLength(1);
		expect(records.find((record) => !record.ok)).toMatchObject({
			failureKind: "too_large",
		});
	});

	test.each([
		{ mode: "incremental", clean: false },
		{ mode: "clean", clean: true },
	])(
		"leaves a valid prior corpus unchanged when $mode metadata preflight fails",
		async ({ clean }) => {
			const root = await tempDir("staged-preflight");
			const { page, summary } = await writeValidCorpus(root);
			const original = await Promise.all([
				readFile(join(root, page.outputPath), "utf8"),
				readFile(join(root, runFiles.manifest), "utf8"),
				readFile(join(root, runFiles.summary), "utf8"),
			]);
			const config = testConfig(root, { clean });
			const next = testPage("# Updated\n\nNew content.");
			await expect(
				commitRun(
					[next],
					[next],
					{
						...summary,
						userAgent: "x".repeat(corpusLimits.summaryBytes),
					},
					config,
				),
			).rejects.toThrow("summary.json exceeds the supported size");
			expect(
				await Promise.all([
					readFile(join(root, page.outputPath), "utf8"),
					readFile(join(root, runFiles.manifest), "utf8"),
					readFile(join(root, runFiles.summary), "utf8"),
				]),
			).toEqual(original);
			expect(await transactionFiles(root)).toEqual([]);
		},
	);

	test.each([
		{ mode: "incremental", clean: false },
		{ mode: "clean", clean: true },
	])("commits a staged corpus in $mode mode", async ({ clean }) => {
		const root = await tempDir("staged-commit");
		await writeValidCorpus(root);
		await writeFile(join(root, "extra.txt"), "extra");
		const config = testConfig(root, { clean });
		const next = testPage("# Updated\n\nCommitted content.");
		await commitRun(
			[next],
			[next],
			buildSummary([next], [next], config),
			config,
		);
		const records = (await readFile(join(root, runFiles.manifest), "utf8"))
			.trim()
			.split("\n");
		expect(records).toHaveLength(1);
		expect(await transactionFiles(root)).toEqual([]);
		if (clean) {
			await expect(readFile(join(root, "extra.txt"), "utf8")).rejects.toThrow();
		} else {
			await expect(readFile(join(root, "extra.txt"), "utf8")).resolves.toBe(
				"extra",
			);
		}
	});
});
