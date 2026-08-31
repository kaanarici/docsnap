import { describe, expect, test } from "bun:test";
import { chmod, mkdir, readdir } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { assertSafeRoot } from "../src/core/fs-safety.ts";
import { prepareOutput } from "../src/output/writer.ts";
import { tempDir, testConfig } from "./fixtures.ts";

describe("output root guards", () => {
	test.each(["/", homedir(), tmpdir(), join(homedir(), "Documents")])(
		"rejects unsafe root: %s",
		(root) => expect(() => assertSafeRoot(root, "unsafe")).toThrow("unsafe"),
	);

	test("accepts a fresh nested output path beneath home", () => {
		expect(() =>
			assertSafeRoot(
				join(homedir(), ".docsnap-test-uncreated", "output"),
				"unsafe",
			),
		).not.toThrow();
	});

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

	test("rejects output beneath a directory writable by other users", async () => {
		const root = await tempDir("shared-output-parent");
		await expect(
			prepareOutput(testConfig(join(root, "private"))),
		).resolves.toBeUndefined();
		const shared = join(root, "shared");
		await mkdir(shared, { mode: 0o777 });
		await chmod(shared, 0o777);
		await expect(
			prepareOutput(testConfig(join(shared, "capture"))),
		).rejects.toThrow("externally writable output path");
		expect(await readdir(shared)).toEqual([]);
		const openRoot = join(root, "open-root");
		await mkdir(openRoot, { mode: 0o777 });
		await chmod(openRoot, 0o777);
		await expect(prepareOutput(testConfig(openRoot))).rejects.toThrow(
			"externally writable output path",
		);
	});
});
