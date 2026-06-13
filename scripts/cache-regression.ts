import {
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	acquireCacheLock,
	cacheKey,
	cacheRequest,
} from "../src/cache/store.ts";
import { parseArgs } from "../src/cli/args.ts";
import { dirLockOwnerFile } from "../src/core/dir-lock.ts";
import { runPipeline } from "../src/core/pipeline.ts";
import type { Config } from "../src/core/types.ts";
import { fetchText, setFetchTransportForTest } from "../src/fetch/fetcher.ts";

const text =
	"Shared cache regression content has enough stable documentation prose for extraction, summary checks, and repeat fetch assertions.";
const cacheDirEnv = "DOCSNAP_CACHE_DIR";
const cacheMaxEnv = "DOCSNAP_CACHE_MAX_MB";

await withCacheEnv("cross-dir", async () => {
	const root = await mkdtemp(join(tmpdir(), "docsnap-cache-out-"));
	let pageCalls = 0;
	setFetchTransportForTest(async (input) => {
		const url = String(input);
		if (isRobots(url)) return robots404(url);
		pageCalls++;
		return response(url, 200, page("Shared Cache", text));
	});
	try {
		const first = await runPipeline(
			config("https://cache.example.com/page", root, "one"),
		);
		const second = await runPipeline(
			config("https://cache.example.com/page", root, "two"),
		);
		assert(first.summary.cache.written === 1);
		assert(second.summary.cache.hits === 1);
		assert(second.summary.cache.bytesRead > 0);
		assert(pageCalls === 1);
	} finally {
		setFetchTransportForTest(undefined);
	}
});

await withCacheEnv("stale", async () => {
	const root = await mkdtemp(join(tmpdir(), "docsnap-cache-stale-"));
	const seenHeaders: Record<string, string>[] = [];
	let pageCalls = 0;
	setFetchTransportForTest(async (input, headers) => {
		const url = String(input);
		if (isRobots(url)) return robots404(url);
		pageCalls++;
		seenHeaders.push(headers);
		if (pageCalls === 1) {
			return response(url, 200, page("Stale", text), {
				"cache-control": "max-age=0",
				etag: '"stale-v1"',
			});
		}
		return response(url, 304, "", {
			"cache-control": "max-age=60",
			etag: '"stale-v1"',
		});
	});
	try {
		await runPipeline(config("https://stale.example.com/page", root, "one"));
		const second = await runPipeline(
			config("https://stale.example.com/page", root, "two"),
		);
		assert(pageCalls === 2);
		assert(seenHeaders[1]?.["if-none-match"] === '"stale-v1"');
		assert(second.summary.cache.stale === 1);
		assert(second.summary.cache.revalidated === 1);
		assert(
			second.records.some(
				(record) => record.ok && record.markdown.includes(text),
			),
		);
	} finally {
		setFetchTransportForTest(undefined);
	}
});

await withCacheEnv("corrupt", async (cacheDir) => {
	const root = await mkdtemp(join(tmpdir(), "docsnap-cache-corrupt-"));
	let pageCalls = 0;
	setFetchTransportForTest(async (input) => {
		const url = String(input);
		if (isRobots(url)) return robots404(url);
		pageCalls++;
		return response(
			url,
			200,
			page(
				"Corrupt",
				`${text} version ${pageCalls} after blob integrity validation.`,
			),
		);
	});
	try {
		await runPipeline(config("https://corrupt.example.com/page", root, "one"));
		const [blob] = await readdir(join(cacheDir, "blobs", "sha256"));
		assert(Boolean(blob));
		await writeFile(join(cacheDir, "blobs", "sha256", blob!), "corrupt body");
		const second = await runPipeline(
			config("https://corrupt.example.com/page", root, "two"),
		);
		assert(pageCalls === 2);
		assert(second.summary.cache.misses === 1);
		assert(
			second.records.some(
				(record) => record.ok && record.markdown.includes("version 2"),
			),
		);
	} finally {
		setFetchTransportForTest(undefined);
	}
});

await withCacheEnv("no-cache", async (cacheDir) => {
	const root = await mkdtemp(join(tmpdir(), "docsnap-cache-off-"));
	let pageCalls = 0;
	setFetchTransportForTest(async (input) => {
		const url = String(input);
		if (isRobots(url)) return robots404(url);
		pageCalls++;
		return response(url, 200, page("No Cache", text));
	});
	try {
		const first = await runPipeline(
			config("https://nocache.example.com/page", root, "one", ["--no-cache"]),
		);
		const second = await runPipeline(
			config("https://nocache.example.com/page", root, "two", ["--no-cache"]),
		);
		assert(!first.summary.cache.enabled);
		assert(!second.summary.cache.enabled);
		assert(pageCalls === 2);
		assert((await countEntries(cacheDir)) === 0);
	} finally {
		setFetchTransportForTest(undefined);
	}
});

await withCacheEnv("evict", async () => {
	const root = await mkdtemp(join(tmpdir(), "docsnap-cache-evict-"));
	process.env[cacheMaxEnv] = "0.0005";
	setFetchTransportForTest(async (input) => {
		const url = String(input);
		if (isRobots(url)) return robots404(url);
		return response(url, 200, page("Evict", `${text} ${"x".repeat(1200)}`));
	});
	try {
		const result = await runPipeline(
			config("https://evict.example.com/page", root, "one"),
		);
		assert(result.summary.cache.written === 1);
		assert(result.summary.cache.evictedBytes > 0);
	} finally {
		delete process.env[cacheMaxEnv];
		setFetchTransportForTest(undefined);
	}
});

await withCacheEnv("clean", async (cacheDir) => {
	const root = await mkdtemp(join(tmpdir(), "docsnap-cache-clean-"));
	let pageCalls = 0;
	setFetchTransportForTest(async (input) => {
		const url = String(input);
		if (isRobots(url)) return robots404(url);
		pageCalls++;
		return response(url, 200, page("Clean", text));
	});
	try {
		await runPipeline(config("https://clean.example.com/page", root, "same"));
		assert((await countEntries(cacheDir)) === 1);
		const second = await runPipeline(
			config("https://clean.example.com/page", root, "same"),
		);
		assert(pageCalls === 1);
		assert(second.summary.cache.hits === 1);
		assert((await countEntries(cacheDir)) === 1);
	} finally {
		setFetchTransportForTest(undefined);
	}
});

await withCacheEnv("lock", async () => {
	let calls = 0;
	const parsed = parseArgs(["https://lock.example.com/page", "--page"]);
	assertConfig(parsed);
	setFetchTransportForTest(async (input) => {
		calls++;
		await Bun.sleep(40);
		return response(String(input), 200, page("Lock", text));
	});
	try {
		const [one, two] = await Promise.all([
			fetchText("https://lock.example.com/page", parsed),
			fetchText("https://lock.example.com/page", parsed),
		]);
		assert(one.ok && two.ok);
		assert(calls <= 2);
		const before = calls;
		const third = await fetchText("https://lock.example.com/page", parsed);
		assert(third.ok);
		assert(calls === before);
	} finally {
		setFetchTransportForTest(undefined);
	}
});

await withCacheEnv("live-lock-not-reaped", async (cacheDir) => {
	const url = "https://live-lock.example.com/page";
	const parsed = parseArgs([url, "--page"]);
	assertConfig(parsed);
	const key = cacheKey(cacheRequest(url, parsed, "text/html"));
	const lockDir = join(cacheDir, "locks", `${key}.lock`);
	await mkdir(lockDir, { recursive: true });
	await writeFile(
		join(lockDir, dirLockOwnerFile),
		`${JSON.stringify({
			pid: process.pid,
			token: "live-cache",
			createdAt: new Date(Date.now() - 120_000).toISOString(),
		})}\n`,
	);
	const lock = await acquireCacheLock(parsed, key);
	assert(lock === undefined);
	const owner = JSON.parse(
		await readFile(join(lockDir, dirLockOwnerFile), "utf8"),
	) as { token?: string };
	assert(owner.token === "live-cache");
});

function config(
	url: string,
	root: string,
	name: string,
	extra: string[] = [],
): Config {
	const parsed = parseArgs([
		url,
		"--page",
		"-o",
		join(root, name),
		"--clean",
		"--quiet",
		...extra,
	]);
	assertConfig(parsed);
	return parsed;
}

async function withCacheEnv(
	name: string,
	run: (cacheDir: string) => Promise<void>,
) {
	const previousDir = process.env[cacheDirEnv];
	const previousMax = process.env[cacheMaxEnv];
	const cacheDir = await mkdtemp(join(tmpdir(), `docsnap-cache-${name}-`));
	process.env[cacheDirEnv] = cacheDir;
	try {
		await run(cacheDir);
	} finally {
		if (previousDir === undefined) delete process.env[cacheDirEnv];
		else process.env[cacheDirEnv] = previousDir;
		if (previousMax === undefined) delete process.env[cacheMaxEnv];
		else process.env[cacheMaxEnv] = previousMax;
		await rm(cacheDir, { recursive: true, force: true });
	}
}

async function countEntries(cacheDir: string) {
	try {
		const entries = await readdir(join(cacheDir, "entries"));
		return entries.filter((entry) => entry.endsWith(".json")).length;
	} catch {
		return 0;
	}
}

function response(
	url: string,
	status: number,
	body: string,
	headers: Record<string, string> = {},
) {
	const lower = new Map(
		Object.entries({ "content-type": "text/html", ...headers }).map(
			([key, value]) => [key.toLowerCase(), value],
		),
	);
	return {
		url,
		status,
		headers: {
			get: (name: string) => lower.get(name.toLowerCase()) ?? null,
			getSetCookie: () => [],
		},
		body: new TextEncoder().encode(body),
	};
}

function isRobots(url: string) {
	return url.endsWith("/robots.txt");
}

function robots404(url: string) {
	return response(url, 404, "not found", { "content-type": "text/plain" });
}

function page(title: string, body: string) {
	return `<html><head><title>${title}</title></head><body><main><h1>${title}</h1><p>${body}</p></main></body></html>`;
}

function assertConfig(value: unknown): asserts value is Config {
	assert(
		typeof value === "object" &&
			value !== null &&
			!("help" in value) &&
			!("version" in value),
	);
}

function assert(condition: unknown): asserts condition {
	if (!condition) throw new Error("assertion failed");
}
