import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, parse } from "node:path";
import { parseArgs } from "../src/cli/args.ts";
import { runPipeline } from "../src/core/pipeline.ts";
import { hashContent } from "../src/core/snapshot.ts";
import type { PageOutput } from "../src/core/types.ts";
import { setFetchTransportForTest } from "../src/fetch/fetcher.ts";

const feedRefreshOutDir = await mkdtemp(
	join(tmpdir(), "docsnap-feed-refresh-"),
);
const feedRefreshConfig = parseArgs([
	"https://feedrefresh.example.com/feed.atom",
	"-m",
	"1",
	"-o",
	feedRefreshOutDir,
	"--clean",
	"--quiet",
]);
assert(!("help" in feedRefreshConfig) && !("version" in feedRefreshConfig));

let feedRefreshRun = 1;
const feedRefreshRequests: Array<{
	run: number;
	url: string;
	headers: Record<string, string>;
}> = [];
setFetchTransportForTest(async (input, headers) => {
	const url = String(input);
	feedRefreshRequests.push({ run: feedRefreshRun, url, headers });
	if (url.endsWith("/llms.txt") || url.endsWith("/robots.txt"))
		return response(url, 404, "not found", "text/plain");
	if (url === "https://feedrefresh.example.com/feed.atom") {
		const published =
			feedRefreshRun === 1 ? "2024-05-01T00:00:00Z" : "2024-06-01T00:00:00Z";
		const updated =
			feedRefreshRun === 1 ? "2024-05-02T00:00:00Z" : "2024-06-02T00:00:00Z";
		return response(
			url,
			200,
			`<feed xmlns="http://www.w3.org/2005/Atom">
				<entry><title>Fresh</title><link href="/post"/><published>${published}</published><updated>${updated}</updated></entry>
			</feed>`,
			"application/atom+xml",
		);
	}
	if (url.endsWith("/post")) {
		if (headers["if-none-match"] === '"feed-post-v1"') {
			return refreshResponse(url, 304, "", { etag: '"feed-post-v1"' });
		}
		return refreshResponse(
			url,
			200,
			page("Feed Fresh", "Stable feed article body for metadata refresh."),
			{ etag: '"feed-post-v1"' },
		);
	}
	return response(url, 404, "not found", "text/plain");
});

try {
	const first = await runPipeline(feedRefreshConfig);
	const firstPost = outputFor(first.records, "/post");
	const firstMarkdown = await readFile(
		join(feedRefreshOutDir, firstPost.outputPath),
		"utf8",
	);
	assert(firstMarkdown.includes('updatedAt: "2024-05-02T00:00:00.000Z"'));

	await Bun.sleep(20);
	feedRefreshRun = 2;
	const second = await runPipeline({ ...feedRefreshConfig, clean: false });
	const secondPost = outputFor(second.records, "/post");
	assert(second.summary.refresh.notModified === 1);
	assert(second.summary.refresh.reused === 1);
	assert(second.summary.refresh.changed === 1);
	assert(
		second.summary.refresh.changedPages.some(
			(page) => page.change === "changed" && page.url.endsWith("/post"),
		),
	);
	assert(
		feedRefreshRequests.some(
			(request) =>
				request.run === 2 &&
				request.url.endsWith("/post") &&
				request.headers["if-none-match"] === '"feed-post-v1"',
		),
	);
	const secondMarkdown = await readFile(
		join(feedRefreshOutDir, secondPost.outputPath),
		"utf8",
	);
	assert(secondMarkdown.includes('publishedAt: "2024-06-01T00:00:00.000Z"'));
	assert(secondMarkdown.includes('updatedAt: "2024-06-02T00:00:00.000Z"'));
	const manifest = await manifestEntries(feedRefreshOutDir);
	const postEntry = manifest.find((entry) =>
		String(entry.url).endsWith("/post"),
	);
	assert(postEntry?.source === "feed");
	assert(postEntry?.publishedAt === "2024-06-01T00:00:00.000Z");
	assert(postEntry?.updatedAt === "2024-06-02T00:00:00.000Z");
} finally {
	setFetchTransportForTest(undefined);
}

const refreshOutDir = await mkdtemp(join(tmpdir(), "docsnap-refresh-"));
const refreshConfig = parseArgs([
	"https://refresh.example.com/docs/",
	"-m",
	"3",
	"-o",
	refreshOutDir,
	"--clean",
	"--quiet",
]);
assert(!("help" in refreshConfig) && !("version" in refreshConfig));

let refreshRun = 1;
const refreshRequests: Array<{ run: number; headers: Record<string, string> }> =
	[];
setFetchTransportForTest(async (input, headers) => {
	refreshRequests.push({ run: refreshRun, headers });
	return refreshFixture(input, headers);
});

try {
	const first = await runPipeline(refreshConfig);
	const firstKeep = outputFor(first.records, "/docs/keep");
	const keepStat = await stat(join(refreshOutDir, firstKeep.outputPath));

	await Bun.sleep(20);
	refreshRun = 2;
	const second = await runPipeline({ ...refreshConfig, clean: false });
	const secondKeep = outputFor(second.records, "/docs/keep");
	assert(second.summary.refresh.notModified === 1);
	assert(second.summary.refresh.reused === 1);
	assert(second.summary.refresh.new === 1);
	assert(second.summary.refresh.removed === 1);
	assert(
		second.summary.refresh.changedPages.some(
			(page) => page.change === "removed" && page.url.endsWith("/docs/remove"),
		),
	);
	assert(
		(await stat(join(refreshOutDir, secondKeep.outputPath))).mtimeMs ===
			keepStat.mtimeMs,
	);
	const manifest = await manifestEntries(refreshOutDir);
	const keepEntry = manifest.find((entry) =>
		String(entry.url).endsWith("/docs/keep"),
	);
	assert(keepEntry?.etag === '"keep-v1"');
	assert(keepEntry?.lastModified === "Tue, 01 Jan 2024 00:00:00 GMT");
	assert(typeof keepEntry?.fetchedAt === "string");
	const handoff = await readFile(
		join(refreshOutDir, "AGENT_README.md"),
		"utf8",
	);
	assert(handoff.includes("## Refresh changes"));

	const manifestBeforeDryRun = await readFile(
		join(refreshOutDir, "manifest.jsonl"),
		"utf8",
	);
	refreshRun = 3;
	const dry = await runPipeline({
		...refreshConfig,
		clean: false,
		dryRun: true,
	});
	assert(dry.summary.refresh.reused === 1);
	assert(
		(await readFile(join(refreshOutDir, "manifest.jsonl"), "utf8")) ===
			manifestBeforeDryRun,
	);

	refreshRun = 4;
	await writeFile(join(refreshOutDir, secondKeep.outputPath), "tampered");
	const corrupt = await runPipeline({ ...refreshConfig, clean: false });
	assert(corrupt.summary.refresh.reused === 0);
	assert(corrupt.summary.refresh.fallbackRefetches === 1);
	assert(corrupt.summary.refresh.skippedWrites === 2);

	refreshRun = 5;
	const clean = await runPipeline({ ...refreshConfig, clean: true });
	assert(!clean.summary.refresh.enabled);
	assert(clean.summary.refresh.reason === "clean");
	assert(
		!refreshRequests.some(
			(request) =>
				request.run === 5 && request.headers["if-none-match"] !== undefined,
		),
	);
} finally {
	setFetchTransportForTest(undefined);
}

const traversalRoot = await mkdtemp(join(tmpdir(), "docsnap-prior-traversal-"));
const traversalOutDir = join(traversalRoot, "out");
await mkdir(traversalOutDir);
const outsideMarkdown = "Outside prior content that must not be reused.";
await writeFile(join(traversalRoot, "outside.md"), priorPage(outsideMarkdown));
await writeFile(
	join(traversalOutDir, "manifest.jsonl"),
	`${JSON.stringify({
		ok: true,
		url: "https://traversal.example.com/docs/page",
		finalUrl: "https://traversal.example.com/docs/page",
		outputPath: "../outside.md",
		contentHash: hashContent(outsideMarkdown),
		status: 200,
		source: "seed",
		extractor: "html",
		confidence: 1,
		links: [],
		qualityReasons: [],
		redirects: [],
		etag: '"evil"',
		fetchedAt: "2024-01-01T00:00:00.000Z",
		timings: { fetchMs: 1, extractMs: 1, writeMs: 1 },
	})}\n`,
);
const traversalConfig = parseArgs([
	"https://traversal.example.com/docs/page",
	"--page",
	"-o",
	traversalOutDir,
	"--quiet",
]);
assert(!("help" in traversalConfig) && !("version" in traversalConfig));

const traversalRequests: Array<{ headers: Record<string, string> }> = [];
setFetchTransportForTest(async (input, headers) => {
	const url = String(input);
	traversalRequests.push({ headers });
	if (headers["if-none-match"] === '"evil"') {
		return refreshResponse(url, 304, "", { etag: '"evil"' });
	}
	return refreshResponse(
		url,
		200,
		page("Traversal", "Network page fetched after unsafe prior manifest."),
		{ etag: '"safe"' },
	);
});

try {
	const result = await runPipeline(traversalConfig);
	const pageOutput = outputFor(result.records, "/docs/page");
	assert(result.summary.refresh.reused === 0);
	assert(result.summary.refresh.priorRecords === 0);
	assert(
		!traversalRequests.some(
			(request) => request.headers["if-none-match"] === '"evil"',
		),
	);
	const markdown = await readFile(
		join(traversalOutDir, pageOutput.outputPath),
		"utf8",
	);
	assert(
		markdown.includes("Network page fetched after unsafe prior manifest."),
	);
	assert(!markdown.includes(outsideMarkdown));
} finally {
	setFetchTransportForTest(undefined);
}

const unsafeRootConfig = parseArgs([
	"https://unsafe-root.example.com/docs/",
	"-o",
	parse(process.cwd()).root,
	"--quiet",
]);
assert(!("help" in unsafeRootConfig) && !("version" in unsafeRootConfig));
setFetchTransportForTest(async () => {
	throw new Error("unsafe output root validation did not run first");
});
try {
	await rejectsWith(
		() => runPipeline(unsafeRootConfig),
		/Refusing to use unsafe output directory/,
	);
	await rejectsWith(
		() => runPipeline({ ...unsafeRootConfig, dryRun: true }),
		/Refusing to use unsafe output directory/,
	);
} finally {
	setFetchTransportForTest(undefined);
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

function refreshFixture(url: string, headers: Record<string, string>) {
	if (url.endsWith("/llms.txt") || url.endsWith("/robots.txt")) {
		return response(url, 404, "not found", "text/plain");
	}
	if (url === "https://refresh.example.com/docs/") {
		return refreshResponse(
			url,
			200,
			shell(refreshRun === 1 ? "remove" : "new"),
		);
	}
	if (url.endsWith("/docs/keep")) {
		if (headers["if-none-match"] === '"keep-v1"') {
			return refreshResponse(url, 304, "", { etag: '"keep-v1"' });
		}
		return refreshResponse(
			url,
			200,
			page(
				"Keep",
				"Stable reference page with reusable documentation content.",
			),
			{
				etag: '"keep-v1"',
				"last-modified": "Tue, 01 Jan 2024 00:00:00 GMT",
			},
		);
	}
	if (url.endsWith("/docs/change")) {
		const text =
			refreshRun === 1
				? "Original change page with old reference documentation."
				: "Updated change page with new reference documentation.";
		return refreshResponse(url, 200, page("Change", text), {
			etag: refreshRun === 1 ? '"change-v1"' : '"change-v2"',
		});
	}
	if (url.endsWith("/docs/remove")) {
		return refreshResponse(
			url,
			200,
			page("Removed", "Removed page that should stay on disk after refresh."),
			{ etag: '"remove-v1"' },
		);
	}
	if (url.endsWith("/docs/new")) {
		return refreshResponse(
			url,
			200,
			page("New", "New page introduced by the refreshed documentation nav."),
			{ etag: '"new-v1"' },
		);
	}
	return response(url, 404, "not found", "text/plain");
}

function refreshResponse(
	url: string,
	status: number,
	body: string,
	headers: Record<string, string> = {},
) {
	const lower = Object.fromEntries(
		Object.entries({ "content-type": "text/html", ...headers }).map(
			([key, value]) => [key.toLowerCase(), value],
		),
	);
	return {
		url,
		status,
		headers: {
			get: (name: string) => lower[name.toLowerCase()] ?? null,
			getSetCookie: () => [],
		},
		body: new TextEncoder().encode(body),
	};
}

function shell(last: "remove" | "new") {
	return `<html><head><script src="/app.js"></script></head><body><div id="app"></div><nav><a href="keep">Keep</a><a href="change">Change</a><a href="${last}">${last}</a></nav></body></html>`;
}

function priorPage(markdown: string) {
	return `---\ntitle: "Outside"\n---\n${markdown}\n`;
}

async function manifestEntries(outDir: string) {
	return (await readFile(join(outDir, "manifest.jsonl"), "utf8"))
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line));
}

function outputFor(
	records: Awaited<ReturnType<typeof runPipeline>>["records"],
	suffix: string,
): PageOutput {
	const record = records.find(
		(item) => item.ok && item.finalUrl.endsWith(suffix),
	);
	assert(record?.ok && record.outputPath);
	return record as PageOutput;
}

function assert(condition: unknown): asserts condition {
	if (!condition) throw new Error("assertion failed");
}

async function rejectsWith(run: () => Promise<unknown>, pattern: RegExp) {
	try {
		await run();
	} catch (error) {
		assert(
			pattern.test(error instanceof Error ? error.message : String(error)),
		);
		return;
	}
	throw new Error("expected rejection");
}
