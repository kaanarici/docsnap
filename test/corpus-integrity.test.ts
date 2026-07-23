import { describe, expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { readSummary, readVerifiedManifest } from "../src/corpus/index.ts";
import { tempDir, writeValidCorpus } from "./fixtures.ts";

describe("corpus integrity", () => {
	test("accepts a valid corpus and rejects a tampered page", async () => {
		const root = await tempDir("corpus-tamper");
		await writeValidCorpus(root);
		await expect(readVerifiedManifest(root)).resolves.toHaveProperty(
			"records.length",
			1,
		);
		const pagePath = join(root, "guide.md");
		await writeFile(
			pagePath,
			`${await readFile(pagePath, "utf8")}\ntampered\n`,
		);
		await expect(readVerifiedManifest(root)).rejects.toThrow("do not match");
	});

	test("normalizes a 0.1.5 summary into the current corpus shape", async () => {
		const root = await tempDir("legacy-summary");
		await writeFile(
			join(root, "summary.json"),
			JSON.stringify({
				seedUrl: "https://docs.example.com/",
				written: 1,
				snapshotVersion: 1,
				rootHash: "a".repeat(64),
				renderedFiles: 1,
				renderedBytes: 10,
				errors: [],
				byFailureKind: {},
			}),
		);
		const summary = await readSummary(root);
		expect(summary.captureMode).toBe("site");
		expect(summary.corpusFiles).toBe(1);
		expect(summary.seed.attempted).toBe(true);
	});
});
