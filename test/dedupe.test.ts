import { expect, test } from "bun:test";
import { dedupeRecords } from "../src/core/dedupe.ts";
import { snapshotStats } from "../src/core/snapshot.ts";
import { buildSummary } from "../src/report/summary.ts";
import { testConfig, testPage } from "./fixtures.ts";

test("keeps the requested seed record on an identity collision", () => {
	const seedUrl = "https://docs.example.com/";
	const { wasSeed: _, ...page } = testPage("# Category\n\n".repeat(100));
	const category = {
		...page,
		url: `${seedUrl}category`,
		finalUrl: seedUrl,
		source: "nav" as const,
	};
	const seed = {
		...testPage("# Home"),
		url: seedUrl,
		finalUrl: seedUrl,
	};
	const [survivor] = dedupeRecords([category, seed]).records;

	expect(survivor?.ok).toBe(true);
	if (!survivor?.ok) return;
	expect(survivor.url).toBe(seedUrl);
	expect(survivor.source).toBe("seed");
	expect(survivor.wasSeed).toBe(true);
	expect(survivor.aliases).toContain(category.url);
	const output = {
		...survivor,
		outputPath: seed.outputPath,
		rendered: seed.rendered,
		outputHash: seed.outputHash,
	};
	const summary = buildSummary(
		[output],
		[output],
		testConfig("unused", { seedUrl }),
		[{ url: seedUrl, source: "seed", wasSeed: true }],
		1,
		snapshotStats([{ path: output.outputPath, body: output.rendered }]),
		1,
	);
	expect(summary.seed.redirected).toBeUndefined();
	expect(summary.warnings).toEqual([]);
});
