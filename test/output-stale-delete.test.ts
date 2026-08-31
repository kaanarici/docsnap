import { describe, expect, test } from "bun:test";
import { mkdir, readdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { PriorPage, PriorState } from "../src/output/prior.ts";
import {
	commitStagedOutput,
	discardStagedOutput,
	stagePages,
	stageStalePages,
} from "../src/output/writer.ts";
import { buildSummary } from "../src/report/summary.ts";
import { tempDir, testConfig, testPage } from "./fixtures.ts";

function priorFor(outputPath: string): PriorState {
	const { markdown, rendered, ...record } = testPage();
	void markdown;
	void rendered;
	const prior: PriorPage = { ...record, outputPath };
	return {
		enabled: true,
		reuseGenerated: true,
		records: [prior],
		find: () => prior,
	};
}

async function commitRemoval(prior: PriorState, root: string) {
	const config = testConfig(root);
	const staged = await stagePages([], config);
	try {
		await stageStalePages(staged, prior, config);
		const summary = buildSummary([], [], config);
		await commitStagedOutput(staged, [], summary, config);
	} finally {
		await discardStagedOutput(staged);
	}
}

describe("stale page deletion", () => {
	test("removes stale pages contained by the real output root", async () => {
		const root = await tempDir("stale-contained");
		await mkdir(join(root, "old"));
		await writeFile(join(root, "old/stale.md"), "stale");
		await commitRemoval(priorFor("old/stale.md"), root);
		await expect(readdir(join(root, "old"))).rejects.toThrow();
	});

	test("does not delete through a symlink outside the output root", async () => {
		const root = await tempDir("stale-root");
		const outside = await tempDir("stale-outside");
		await mkdir(root, { recursive: true });
		await writeFile(join(outside, "keep.md"), "keep");
		await symlink(outside, join(root, "linked"));
		await expect(
			commitRemoval(priorFor("linked/keep.md"), root),
		).rejects.toThrow("outside output directory");
		expect(await readFile(join(outside, "keep.md"), "utf8")).toBe("keep");
	});

	test("unlinks a stale symlink without deleting its current target", async () => {
		const root = await tempDir("stale-symlink");
		await writeFile(join(root, "keep.md"), "keep");
		await symlink("keep.md", join(root, "stale.md"));
		await commitRemoval(priorFor("stale.md"), root);
		expect(await readFile(join(root, "keep.md"), "utf8")).toBe("keep");
		await expect(readFile(join(root, "stale.md"), "utf8")).rejects.toThrow();
	});

	test("restores stale pages when the metadata commit fails", async () => {
		const root = await tempDir("stale-rollback");
		await writeFile(join(root, "stale.md"), "stale");
		await mkdir(join(root, "manifest.jsonl"));
		await expect(commitRemoval(priorFor("stale.md"), root)).rejects.toThrow(
			"non-file output",
		);
		expect(await readFile(join(root, "stale.md"), "utf8")).toBe("stale");
	});
});
