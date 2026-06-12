import { mkdir, mkdtemp, readdir, readFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, parse } from "node:path";
import { parseArgs } from "../src/cli/args.ts";
import { runPipeline } from "../src/core/pipeline.ts";
import { setFetchTransportForTest } from "../src/fetch/fetcher.ts";
import { prepareOutput, writePages } from "../src/output/writer.ts";

const outDir = await mkdtemp(join(tmpdir(), "docsnap-pipeline-"));
const config = parseArgs([
	"https://docs.example.com/",
	"-m",
	"2",
	"-o",
	outDir,
	"--clean",
	"--quiet",
]);
assert(!("help" in config) && !("version" in config));

setFetchTransportForTest(async (input) => {
	const url = String(input);
	if (url.endsWith("/llms.txt"))
		return response(url, 404, "not found", "text/plain");
	if (url.endsWith("/robots.txt"))
		return response(url, 404, "not found", "text/plain");
	if (url.endsWith("/bad"))
		return response(url, 200, `<main></main><script src="/app.js"></script>`);
	if (url.endsWith("/good"))
		return response(url, 200, page("Good page", "Recovered useful docs page."));
	return response(
		url,
		200,
		`<html><head><title>Docs</title></head><body><main><h1>Docs</h1><p>Seed overview for the docs.</p><nav><a href="/bad">Bad</a><a href="/bad/">Duplicate bad</a><a href="/good">Good</a></nav></main></body></html>`,
	);
});

try {
	const result = await runPipeline(config);
	assert(result.summary.written === 2);
	assert(result.summary.failed === 1);
	assert(result.summary.discovered === 3);
	assert(
		result.records.filter((record) => record.ok && record.outputPath).length ===
			2,
	);
	assert(
		result.records.some((record) => !record.ok && record.url.endsWith("/bad")),
	);
	const recovered = result.records.find(
		(record) => record.ok && record.finalUrl.endsWith("/good"),
	);
	assert(recovered?.ok && recovered.outputPath);
	const recoveredPage = await readFile(
		join(outDir, recovered.outputPath),
		"utf8",
	);
	assert(recoveredPage.includes("Recovered useful docs page"));
	const manifest = await readFile(join(outDir, "manifest.jsonl"), "utf8");
	assert(manifest.trim().split("\n").length === 3);
} finally {
	setFetchTransportForTest(undefined);
}

const staleOutDir = await mkdtemp(join(tmpdir(), "docsnap-pipeline-stale-"));
const staleConfig = parseArgs([
	"https://stale.example.com/",
	"-m",
	"2",
	"-o",
	staleOutDir,
	"--clean",
	"--quiet",
]);
assert(!("help" in staleConfig) && !("version" in staleConfig));

setFetchTransportForTest(async (input) => {
	const url = String(input);
	if (url.endsWith("/llms.txt") || url.endsWith("/robots.txt"))
		return response(url, 404, "not found", "text/plain");
	if (url.endsWith("/missing"))
		return response(url, 404, "not found", "text/html");
	if (url.endsWith("/extra"))
		return response(
			url,
			200,
			page("Extra", "Extra page should not be chased."),
		);
	return response(
		url,
		200,
		`<html><head><title>Docs</title></head><body><main><h1>Docs</h1><p>Seed overview for stale docs.</p><nav><a href="/missing">Missing</a><a href="/extra">Extra</a></nav></main></body></html>`,
	);
});

try {
	const result = await runPipeline(staleConfig);
	assert(result.summary.written === 1);
	assert(result.summary.failed === 1);
	assert(result.summary.discovered === 2);
	const handoff = await readFile(join(staleOutDir, "AGENT_README.md"), "utf8");
	assert(handoff.includes("Stale/not-found links: 1"));
} finally {
	setFetchTransportForTest(undefined);
}

const httpOutDir = await mkdtemp(join(tmpdir(), "docsnap-pipeline-http-"));
const httpConfig = parseArgs([
	"https://http.example.com/",
	"-m",
	"2",
	"-o",
	httpOutDir,
	"--clean",
	"--quiet",
]);
assert(!("help" in httpConfig) && !("version" in httpConfig));

setFetchTransportForTest(async (input) => {
	const url = String(input);
	if (url.endsWith("/llms.txt") || url.endsWith("/robots.txt"))
		return response(url, 404, "not found", "text/plain");
	if (url.endsWith("/broken"))
		return response(url, 500, "temporary upstream failure", "text/html");
	if (url.endsWith("/extra"))
		return response(
			url,
			200,
			page("Extra", "Extra page should not be chased."),
		);
	return response(
		url,
		200,
		`<html><head><title>Docs</title></head><body><main><h1>Docs</h1><p>Seed overview for flaky docs.</p><nav><a href="/broken">Broken</a><a href="/extra">Extra</a></nav></main></body></html>`,
	);
});

try {
	const result = await runPipeline(httpConfig);
	assert(result.summary.written === 1);
	assert(result.summary.failed === 1);
	assert(result.summary.discovered === 2);
} finally {
	setFetchTransportForTest(undefined);
}

const feedOutDir = await mkdtemp(join(tmpdir(), "docsnap-pipeline-feed-"));
const feedConfig = parseArgs([
	"https://feedpipe.example.com/feed.atom",
	"-m",
	"2",
	"-o",
	feedOutDir,
	"--clean",
	"--quiet",
]);
assert(!("help" in feedConfig) && !("version" in feedConfig));

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
		return response(url, 200, page("Post One", "First feed captured page."));
	if (url.endsWith("/post-2"))
		return response(url, 200, page("Post Two", "Second feed captured page."));
	return response(url, 404, "not found", "text/plain");
});

try {
	const result = await runPipeline(feedConfig);
	assert(result.summary.written === 2);
	assert(result.summary.bySource.feed === 2);
	const dated = result.records.find(
		(record) => record.ok && record.publishedAt && record.updatedAt,
	);
	assert(dated?.ok && dated.outputPath);
	const markdown = await readFile(join(feedOutDir, dated.outputPath), "utf8");
	assert(markdown.includes('source: "feed"'));
	assert(markdown.includes('publishedAt: "2024-05-01T00:00:00.000Z"'));
	assert(markdown.includes('updatedAt: "2024-05-02T00:00:00.000Z"'));
	const manifest = (await readFile(join(feedOutDir, "manifest.jsonl"), "utf8"))
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line));
	const entry = manifest.find((item) => String(item.url).endsWith("/post-1"));
	assert(entry.source === "feed");
	assert(entry.publishedAt === "2024-05-01T00:00:00.000Z");
	assert(entry.updatedAt === "2024-05-02T00:00:00.000Z");
} finally {
	setFetchTransportForTest(undefined);
}

const symlinkRepo = await mkdtemp(join(tmpdir(), "docsnap-output-repo-"));
const symlinkTarget = await mkdtemp(join(tmpdir(), "docsnap-output-target-"));
await symlink(symlinkTarget, join(symlinkRepo, "docsnap"));
const originalCwd = process.cwd();
process.chdir(symlinkRepo);
try {
	const symlinkConfig = parseArgs([
		"https://docs.example.com/",
		"-o",
		"docsnap/site",
	]);
	assert(!("help" in symlinkConfig) && !("version" in symlinkConfig));
	await rejects(() => prepareOutput(symlinkConfig));
	assert((await readdir(symlinkTarget)).length === 0);
} finally {
	process.chdir(originalCwd);
}
const rootConfig = parseArgs([
	"https://docs.example.com/",
	"-o",
	parse(process.cwd()).root,
]);
assert(!("help" in rootConfig) && !("version" in rootConfig));
await rejects(() => prepareOutput(rootConfig));

const nestedOut = await mkdtemp(join(tmpdir(), "docsnap-nested-out-"));
const nestedTarget = await mkdtemp(join(tmpdir(), "docsnap-nested-target-"));
await symlink(nestedTarget, join(nestedOut, "leak"));
await mkdir(nestedOut, { recursive: true });
await rejects(() =>
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
			},
		],
		{ ...httpConfig, outDir: nestedOut, clean: false },
	),
);
assert((await readdir(nestedTarget)).length === 0);

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

function assert(condition: unknown): asserts condition {
	if (!condition) throw new Error("assertion failed");
}

async function rejects(run: () => Promise<unknown>) {
	try {
		await run();
	} catch {
		return;
	}
	throw new Error("expected rejection");
}
