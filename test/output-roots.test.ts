import { describe, expect, test } from "bun:test";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { assertSafeRoot } from "../src/core/fs-safety.ts";
import { prepareOutput } from "../src/output/writer.ts";
import { tempDir, testConfig } from "./fixtures.ts";

describe("output root guards", () => {
	test.each([
		"/",
		homedir(),
		tmpdir(),
		join(homedir(), "Documents"),
	])("rejects unsafe root: %s", (root) =>
		expect(() => assertSafeRoot(root, "unsafe")).toThrow("unsafe"));

	test("rejects a relative --out that escapes the current directory", async () => {
		const parent = await tempDir("relative-parent");
		const escaped = `../${parent.split("/").pop()}-escaped`;
		await expect(prepareOutput(testConfig(escaped))).rejects.toThrow(
			"outside current directory",
		);
	});

	test("refuses --clean on the current working directory", async () => {
		await expect(
			prepareOutput(testConfig(process.cwd(), { clean: true })),
		).rejects.toThrow("clean unsafe output directory");
	});
});
