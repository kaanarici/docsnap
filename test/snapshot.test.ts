import { describe, expect, test } from "bun:test";
import {
	hashContent,
	snapshotLeaf,
	snapshotStats,
	snapshotStatsFromLeaves,
} from "../src/core/snapshot.ts";

describe("snapshot roots", () => {
	test("is deterministic across input order", () => {
		const files = [
			{ path: "a.md", body: "alpha" },
			{ path: "b.md", body: "beta" },
			{ path: "c.md", body: "gamma" },
		];
		expect(snapshotStats(files)).toEqual(snapshotStats([...files].reverse()));
	});

	test("changes for path or content changes", () => {
		const baseline = snapshotStats([{ path: "a.md", body: "alpha" }]);
		expect(snapshotStats([{ path: "b.md", body: "alpha" }]).rootHash).not.toBe(
			baseline.rootHash,
		);
		expect(snapshotStats([{ path: "a.md", body: "beta" }]).rootHash).not.toBe(
			baseline.rootHash,
		);
	});

	test("compact and prehashed leaves preserve snapshot stats", () => {
		const files = [
			{ path: "a.md", body: "alpha" },
			{ path: "unicode.md", body: "café 😀 \ud800" },
		];
		for (const prehashed of [false, true]) {
			const leaves = files.map((file) =>
				snapshotLeaf(
					file.path,
					file.body,
					prehashed ? hashContent(file.body) : undefined,
				),
			);
			expect(snapshotStatsFromLeaves(leaves)).toEqual(snapshotStats(files));
		}
	});
});
