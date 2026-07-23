import { describe, expect, test } from "bun:test";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { PriorPage, PriorState } from "../src/output/prior.ts";
import { removeStalePages } from "../src/output/writer.ts";
import { tempDir, testConfig, testPage } from "./fixtures.ts";

function priorFor(outputPath: string): PriorState {
	const { markdown, rendered, ...record } = testPage();
	void markdown;
	void rendered;
	const prior: PriorPage = { ...record, outputPath };
	return {
		enabled: true,
		records: [prior],
		find: () => prior,
	};
}

describe("stale page deletion", () => {
	test("removes stale pages contained by the real output root", async () => {
		const root = await tempDir("stale-contained");
		await writeFile(join(root, "stale.md"), "stale");
		await removeStalePages(priorFor("stale.md"), [], testConfig(root));
		await expect(readFile(join(root, "stale.md"), "utf8")).rejects.toThrow();
	});

	test("does not delete through a symlink outside the output root", async () => {
		const root = await tempDir("stale-root");
		const outside = await tempDir("stale-outside");
		await mkdir(root, { recursive: true });
		await writeFile(join(outside, "keep.md"), "keep");
		await symlink(outside, join(root, "linked"));
		await expect(
			removeStalePages(priorFor("linked/keep.md"), [], testConfig(root)),
		).rejects.toThrow("outside output directory");
		expect(await readFile(join(outside, "keep.md"), "utf8")).toBe("keep");
	});
});
