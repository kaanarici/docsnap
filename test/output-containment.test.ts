import { describe, expect, test } from "bun:test";
import { mkdir, symlink } from "node:fs/promises";
import { join } from "node:path";
import {
	realPathIsInside,
	resolveSafeRelativePath,
} from "../src/core/fs-safety.ts";
import { writePages } from "../src/output/writer.ts";
import { tempDir, testConfig, testPage } from "./fixtures.ts";

describe("output containment", () => {
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
		expect(await realPathIsInside(root, join(root, "linked", "page.md"))).toBe(
			false,
		);
		await expect(
			writePages(
				[{ ...testPage(), outputPath: "linked/page.md" }],
				testConfig(root),
			),
		).rejects.toThrow("outside output directory");
	});
});
