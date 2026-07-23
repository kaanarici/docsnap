import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { hashContent } from "../src/core/snapshot.ts";
import { tempDir, writeValidCorpus } from "./fixtures.ts";

describe("content and output hashes", () => {
	test("uses deterministic SHA-256 content hashes", () => {
		expect(hashContent("abc")).toBe(
			"ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
		);
		expect(hashContent("abc")).not.toBe(hashContent("abd"));
	});

	test("writes outputHash from the exact stored page body", async () => {
		const root = await tempDir("output-hash");
		const { page } = await writeValidCorpus(root);
		const manifest = JSON.parse(
			(await readFile(join(root, "manifest.jsonl"), "utf8")).trim(),
		) as { contentHash: string; outputHash: string };
		expect(manifest.contentHash).toBe(page.contentHash);
		expect(manifest.outputHash).toBe(hashContent(page.rendered));
	});
});
