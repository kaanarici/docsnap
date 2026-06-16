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
import { fetchText, setFetchTransportForTest } from "../src/fetch/fetcher.ts";
import {
	assert,
	assertConfig,
	cacheMaxEnv,
	config,
	countEntries,
	page,
	response,
	withCacheEnv,
} from "./cache-fixtures.ts";
import {
	logSandboxNetworkSkip,
	sandboxNetworkDisabled,
	startLoopbackServer,
} from "./local-fixture.ts";

const text =
	"Shared cache regression content has enough stable documentation prose for extraction, summary checks, and repeat fetch assertions.";
type CliSummary = {
	written: number;
	failed: number;
	cache: {
		written: number;
		hits: number;
		stale: number;
		revalidated: number;
		bytesRead: number;
	};
};

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

if (sandboxNetworkDisabled()) {
	logSandboxNetworkSkip("cache-regression cross-process cache smoke");
} else {
	await crossProcessCacheSmoke();
}

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

async function crossProcessCacheSmoke() {
	const tmpRoot = await mkdtemp(join(tmpdir(), "docsnap-cache-process-"));
	const cacheDir = join(tmpRoot, "cache");
	let origin = "";
	let freshRequests = 0;
	let staleRequests = 0;
	const server = await startLoopbackServer((request) => {
		const url = new URL(request.url);
		if (url.pathname === "/robots.txt") {
			return webResponse("User-agent: *\nAllow: /\n", "text/plain");
		}
		if (url.pathname === "/llms.txt") {
			return webResponse("not found", "text/plain", 404);
		}
		if (url.pathname === "/fresh") {
			freshRequests++;
			return webResponse(page("Fresh", `${text} Fresh cache-hit page.`), {
				"cache-control": "max-age=60",
			});
		}
		if (url.pathname === "/stale") {
			staleRequests++;
			if (request.headers.get("if-none-match") === '"stale-v1"') {
				return new Response(null, {
					status: 304,
					headers: {
						"cache-control": "max-age=0",
						etag: '"stale-v1"',
					},
				});
			}
			return webResponse(page("Stale", `${text} Stale ETag page.`), {
				"cache-control": "max-age=0",
				etag: '"stale-v1"',
			});
		}
		return webResponse(
			page(
				"Cache Root",
				`${text} The root links to a fresh page and stale page for cross-process cache verification.
				<a href="${origin}/fresh">Fresh</a>
				<a href="${origin}/stale">Stale</a>`,
			),
			{ "cache-control": "max-age=60" },
		);
	});
	try {
		origin = server.origin;
		const first = await runDocsnapProcess(
			origin,
			join(tmpRoot, "one"),
			cacheDir,
		);
		const second = await runDocsnapProcess(
			origin,
			join(tmpRoot, "two"),
			cacheDir,
		);
		assert(first.written >= 3);
		assert(first.cache.written >= 3);
		assert(second.cache.hits >= 1);
		assert(second.cache.stale >= 1);
		assert(second.cache.revalidated >= 1);
		assert(second.cache.bytesRead > 0);
		assert(freshRequests === 1);
		assert(staleRequests === 2);
	} finally {
		await server.stop();
		await rm(tmpRoot, { recursive: true, force: true });
	}
}

async function runDocsnapProcess(
	origin: string,
	outDir: string,
	cacheDir: string,
): Promise<CliSummary> {
	const subprocess = Bun.spawn({
		cmd: [
			"bun",
			"bin/docsnap",
			`${origin}/`,
			"-m",
			"3",
			"--json",
			"--quiet",
			"-o",
			outDir,
		],
		cwd: process.cwd(),
		env: {
			...cleanEnv(),
			DOCSNAP_ALLOW_TEST_HOST: origin,
			DOCSNAP_CACHE_DIR: cacheDir,
		},
		stdout: "pipe",
		stderr: "pipe",
	});
	const [exitCode, stdout, stderr] = await Promise.all([
		subprocess.exited,
		new Response(subprocess.stdout).text(),
		new Response(subprocess.stderr).text(),
	]);
	assert(exitCode === 0, stderr || stdout);
	assert(stderr.trim() === "", stderr);
	const cliJson = JSON.parse(stdout) as CliSummary;
	const summary = JSON.parse(
		await readFile(join(outDir, "summary.json"), "utf8"),
	) as CliSummary;
	assert(cliJson.cache.written === summary.cache.written);
	assert(cliJson.cache.hits === summary.cache.hits);
	assert(cliJson.cache.revalidated === summary.cache.revalidated);
	return summary;
}

function isRobots(url: string) {
	return url.endsWith("/robots.txt");
}

function robots404(url: string) {
	return response(url, 404, "not found", { "content-type": "text/plain" });
}

function webResponse(
	body: string,
	contentTypeOrHeaders: string | Record<string, string> = "text/html",
	status = 200,
) {
	const headers =
		typeof contentTypeOrHeaders === "string"
			? { "content-type": contentTypeOrHeaders }
			: { "content-type": "text/html", ...contentTypeOrHeaders };
	return new Response(body, { status, headers });
}

function cleanEnv(): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value !== undefined) env[key] = value;
	}
	return env;
}
