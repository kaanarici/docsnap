import { expect, onTestFinished, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { buildPipelineConfig } from "../src/core/config.ts";
import { runPipeline } from "../src/core/pipeline.ts";
import { readCorpus } from "../src/corpus/index.ts";
import { setTestEnv, tempDir } from "./fixtures.ts";

test("refresh removes cleanly missing pages but preserves an incomplete corpus", async () => {
	let mode: "baseline" | "removed" | "failed" = "baseline";
	const page = (title: string, links = "") =>
		new Response(
			`<main><h1>${title}</h1><p>${title} documentation.</p>${links}</main>`,
			{
				headers: { "content-type": "text/html" },
			},
		);
	const server = Bun.serve({
		port: 0,
		fetch(request) {
			const path = new URL(request.url).pathname;
			if (path === "/robots.txt")
				return new Response("User-agent: *\nAllow: /");
			if (path === "/docs/") return page("Docs", '<a href="/docs/hub">Hub</a>');
			if (path === "/docs/hub") {
				if (mode === "failed")
					return new Response("unavailable", { status: 503 });
				return page(
					"Hub",
					mode === "removed"
						? '<a href="/docs/a">A</a><a href="/docs/c">C</a>'
						: '<a href="/docs/a">A</a><a href="/docs/b">B</a>',
				);
			}
			if (path === "/docs/a") return page("Alpha");
			if (path === "/docs/b" && mode === "baseline") return page("Beta");
			if (path === "/docs/c" && mode === "removed") return page("Gamma");
			return new Response("missing", { status: 404 });
		},
	});
	onTestFinished(() => server.stop(true));
	const origin = `http://127.0.0.1:${server.port}`;
	setTestEnv("DOCSNAP_ALLOW_TEST_HOST", origin);
	const config = (outDir: string) =>
		buildPipelineConfig({
			seedUrl: `${origin}/docs/`,
			outDir,
			max: 4,
			concurrency: 2,
			cache: false,
		});

	const removable = await tempDir("refresh-remove");
	await runPipeline(config(removable));
	mode = "removed";
	const refreshed = await runPipeline(config(removable));
	expect(refreshed.summary.refresh).toMatchObject({ new: 1, removed: 1 });
	expect((await readCorpus(removable)).records.map(({ url }) => url)).toEqual([
		`${origin}/docs/`,
		`${origin}/docs/hub`,
		`${origin}/docs/a`,
		`${origin}/docs/c`,
	]);

	mode = "baseline";
	const preserved = await tempDir("refresh-preserve");
	await runPipeline(config(preserved));
	const before = await Promise.all(
		["summary.json", "manifest.jsonl"].map((name) =>
			readFile(`${preserved}/${name}`, "utf8"),
		),
	);
	mode = "failed";
	await expect(runPipeline(config(preserved))).rejects.toThrow(
		"Refresh was incomplete",
	);
	expect(
		await Promise.all(
			["summary.json", "manifest.jsonl"].map((name) =>
				readFile(`${preserved}/${name}`, "utf8"),
			),
		),
	).toEqual(before);
});
