import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, parse } from "node:path";
import { buildPipelineConfig, parseArgs } from "../src/cli/args.ts";
import { runPipeline } from "../src/core/pipeline.ts";
import { isWritten } from "../src/core/records.ts";
import { setFetchTransportForTest } from "../src/fetch/fetcher.ts";
import { prepareOutput, writePages } from "../src/output/writer.ts";

afterEach(() => {
	setFetchTransportForTest(undefined);
});

describe("pipeline capture outcomes", () => {
	test("deduplicates equivalent failures and writes recovered pages", async () => {
		const outDir = await mkdtemp(join(tmpdir(), "docsnap-pipeline-"));
		const config = makeConfig([
			"https://docs.example.com/",
			"-m",
			"2",
			"-o",
			outDir,
			"--clean",
			"--quiet",
		]);

		setFetchTransportForTest(async (input) => {
			const url = String(input);
			if (url.endsWith("/llms.txt"))
				return response(url, 404, "not found", "text/plain");
			if (url.endsWith("/robots.txt"))
				return response(url, 404, "not found", "text/plain");
			if (url.endsWith("/bad"))
				return response(
					url,
					200,
					`<main></main><script src="/app.js"></script>`,
				);
			if (url.endsWith("/good"))
				return response(
					url,
					200,
					page("Good page", "Recovered useful docs page."),
				);
			return response(
				url,
				200,
				`<html><head><title>Docs</title></head><body><main><h1>Docs</h1><p>Seed overview for the docs.</p><nav><a href="/bad">Bad</a><a href="/bad/">Duplicate bad</a><a href="/good">Good</a></nav></main></body></html>`,
			);
		});

		const result = await runPipeline(config);
		expect(result.summary.written).toBe(2);
		expect(result.summary.failed).toBe(1);
		expect(result.summary.discovered).toBe(3);
		expect(result.records.filter(isWritten)).toHaveLength(2);
		expect(
			result.records.some(
				(record) => !record.ok && record.url.endsWith("/bad"),
			),
		).toBe(true);
		const recovered = result.records.find(
			(record) => isWritten(record) && record.finalUrl.endsWith("/good"),
		);
		if (!recovered || !isWritten(recovered)) {
			throw new Error("expected recovered record");
		}
		const recoveredPage = await readFile(
			join(outDir, recovered.outputPath),
			"utf8",
		);
		expect(recoveredPage).toContain("Recovered useful docs page");
		const manifest = await readFile(join(outDir, "manifest.jsonl"), "utf8");
		expect(manifest.trim().split("\n")).toHaveLength(3);
	});

	test.each([
		[
			"stale not-found page",
			"docsnap-pipeline-stale-",
			"https://stale.example.com/",
			"/missing",
			404,
			"not found",
			"text/html",
			"Seed overview for stale docs.",
		],
		[
			"upstream HTTP failure",
			"docsnap-pipeline-http-",
			"https://http.example.com/",
			"/broken",
			500,
			"temporary upstream failure",
			"text/html",
			"Seed overview for flaky docs.",
		],
	])("stops discovery after a %s", async (_label, prefix, seedUrl, failurePath, status, body, contentType, seedText) => {
		const outDir = await mkdtemp(join(tmpdir(), prefix));
		const config = makeConfig([
			seedUrl,
			"-m",
			"2",
			"-o",
			outDir,
			"--clean",
			"--quiet",
		]);

		setFetchTransportForTest(async (input) => {
			const url = String(input);
			if (url.endsWith("/llms.txt") || url.endsWith("/robots.txt"))
				return response(url, 404, "not found", "text/plain");
			if (url.endsWith(failurePath))
				return response(url, status, body, contentType);
			if (url.endsWith("/extra"))
				return response(
					url,
					200,
					page("Extra", "Extra page should not be chased."),
				);
			return response(
				url,
				200,
				`<html><head><title>Docs</title></head><body><main><h1>Docs</h1><p>${seedText}</p><nav><a href="${failurePath}">${failurePath === "/missing" ? "Missing" : "Broken"}</a><a href="/extra">Extra</a></nav></main></body></html>`,
			);
		});

		const result = await runPipeline(config);
		expect(result.summary.written).toBe(1);
		expect(result.summary.failed).toBe(1);
		expect(result.summary.discovered).toBe(2);
	});

	test("preserves feed metadata in Markdown and manifest output", async () => {
		const feedOutDir = await mkdtemp(join(tmpdir(), "docsnap-pipeline-feed-"));
		const feedConfig = makeConfig([
			"https://feedpipe.example.com/feed.atom",
			"-m",
			"2",
			"-o",
			feedOutDir,
			"--clean",
			"--quiet",
		]);

		setFetchTransportForTest(async (input) => {
			const url = String(input);
			if (url.endsWith("/llms.txt") || url.endsWith("/robots.txt"))
				return response(url, 404, "not found", "text/plain");
			if (url === "https://feedpipe.example.com/feed.atom") {
				return response(
					url,
					200,
					`<feed xmlns="http://www.w3.org/2005/Atom">
				<entry><title>One</title><link href="/post-1"/><published>2024-05-01T00:00:00Z</published><updated>2024-05-02T00:00:00Z</updated></entry>
				<entry><title>Two</title><link href="/post-2"/><updated>2024-05-03T00:00:00Z</updated></entry>
			</feed>`,
					"application/atom+xml",
				);
			}
			if (url.endsWith("/post-1"))
				return response(
					url,
					200,
					page("Post One", "First feed captured page."),
				);
			if (url.endsWith("/post-2"))
				return response(
					url,
					200,
					page("Post Two", "Second feed captured page."),
				);
			return response(url, 404, "not found", "text/plain");
		});

		const result = await runPipeline(feedConfig);
		expect(result.summary.written).toBe(2);
		expect(result.summary.bySource.feed).toBe(2);
		const dated = result.records.find(
			(record) => isWritten(record) && record.publishedAt && record.updatedAt,
		);
		if (!dated || !isWritten(dated)) {
			throw new Error("expected dated feed record");
		}
		const markdown = await readFile(join(feedOutDir, dated.outputPath), "utf8");
		expect(markdown).toContain('source: "feed"');
		expect(markdown).toContain('publishedAt: "2024-05-01T00:00:00.000Z"');
		expect(markdown).toContain('updatedAt: "2024-05-02T00:00:00.000Z"');
		const manifest = (
			await readFile(join(feedOutDir, "manifest.jsonl"), "utf8")
		)
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		const entry = manifest.find((item) => String(item.url).endsWith("/post-1"));
		expect(entry.source).toBe("feed");
		expect(entry.publishedAt).toBe("2024-05-01T00:00:00.000Z");
		expect(entry.updatedAt).toBe("2024-05-02T00:00:00.000Z");
	});
});

describe("output path safety", () => {
	test("symlink output roots are refused without writing through the link", async () => {
		const symlinkRepo = await mkdtemp(join(tmpdir(), "docsnap-output-repo-"));
		const symlinkTarget = await mkdtemp(
			join(tmpdir(), "docsnap-output-target-"),
		);
		await symlink(symlinkTarget, join(symlinkRepo, "docsnap"));
		const originalCwd = process.cwd();
		process.chdir(symlinkRepo);
		try {
			const symlinkConfig = makeConfig([
				"https://docs.example.com/",
				"-o",
				"docsnap/site",
			]);
			await expect(prepareOutput(symlinkConfig)).rejects.toThrow();
			expect(await readdir(symlinkTarget)).toHaveLength(0);
		} finally {
			process.chdir(originalCwd);
		}
	});

	test("filesystem root output is refused", async () => {
		const rootConfig = makeConfig([
			"https://docs.example.com/",
			"-o",
			parse(process.cwd()).root,
		]);
		await expect(prepareOutput(rootConfig)).rejects.toThrow();
	});

	test("clean validates unsafe relative output before deleting", async () => {
		// --clean must validate the path BEFORE the destructive rm: a relative --out pointing
		// outside cwd must be refused without deleting it (data-loss guard)
		const cleanBase = await mkdtemp(join(tmpdir(), "docsnap-clean-"));
		await mkdir(join(cleanBase, "work"));
		await mkdir(join(cleanBase, "victim"));
		await mkdir(join(cleanBase, "victim", "keep"));
		const originalCwd = process.cwd();
		process.chdir(join(cleanBase, "work"));
		try {
			const cleanConfig = makeConfig([
				"https://docs.example.com/",
				"-o",
				"../victim",
				"--clean",
			]);
			await expect(prepareOutput(cleanConfig)).rejects.toThrow();
			// the victim dir (outside cwd) must NOT have been deleted by the refused --clean
			expect(await readdir(join(cleanBase, "victim"))).toHaveLength(1);
		} finally {
			process.chdir(originalCwd);
		}
	});

	test("nested symlink output paths are refused without writing through the link", async () => {
		const nestedOut = await mkdtemp(join(tmpdir(), "docsnap-nested-out-"));
		const nestedTarget = await mkdtemp(
			join(tmpdir(), "docsnap-nested-target-"),
		);
		await symlink(nestedTarget, join(nestedOut, "leak"));
		await mkdir(nestedOut, { recursive: true });
		const httpOutDir = await mkdtemp(join(tmpdir(), "docsnap-pipeline-http-"));
		const httpConfig = makeConfig([
			"https://http.example.com/",
			"-m",
			"2",
			"-o",
			httpOutDir,
			"--clean",
			"--quiet",
		]);

		await expect(
			writePages(
				[
					{
						ok: true,
						url: "https://docs.example.com/leak/nested/page",
						finalUrl: "https://docs.example.com/leak/nested/page",
						redirects: [],
						fetchedAt: "2026-01-01T00:00:00.000Z",
						injectionSignals: [],
						status: 200,
						source: "seed",
						timings: { fetchMs: 1, extractMs: 1, writeMs: 0 },
						markdown: "safe",
						links: [],
						contentHash: "safe",
						extractor: "html",
						confidence: 1,
						qualityReasons: [],
						outputPath: "leak/nested/page.md",
						rendered: "safe",
					},
				],
				{ ...httpConfig, outDir: nestedOut, clean: false },
			),
		).rejects.toThrow();
		expect(await readdir(nestedTarget)).toHaveLength(0);
	});
});

function makeConfig(args: string[]) {
	const parsed = parseArgs(args);
	if ("help" in parsed || "version" in parsed) {
		throw new Error("parseArgs returned help/version");
	}
	return buildPipelineConfig(parsed.run);
}

function page(title: string, text: string) {
	return `<html><head><title>${title}</title></head><body><main><h1>${title}</h1><p>${text}</p></main></body></html>`;
}

function response(
	url: string,
	status: number,
	body: string,
	contentType = "text/html",
) {
	return {
		url,
		status,
		headers: {
			get: (name: string) => (name === "content-type" ? contentType : null),
			getSetCookie: () => [],
		},
		body: new TextEncoder().encode(body),
	};
}
