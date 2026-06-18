import { afterEach, describe, expect, test } from "bun:test";
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
	cacheMaxEnv,
	config,
	countEntries,
	page,
	response,
	withCacheEnv,
} from "../scripts/cache-fixtures.ts";
import {
	sandboxNetworkDisabled,
	startLoopbackServer,
} from "../scripts/local-fixture.ts";
import { freshUntilFor } from "../src/cache/policy.ts";
import {
	acquireCacheLock,
	cacheKey,
	cacheRequest,
} from "../src/cache/store.ts";
import { buildPipelineConfig, parseArgs } from "../src/cli/args.ts";
import { dirLockOwnerFile } from "../src/core/dir-lock.ts";
import { runPipeline } from "../src/core/pipeline.ts";
import type { PipelineConfig } from "../src/core/types.ts";
import { fetchText, setFetchTransportForTest } from "../src/fetch/fetcher.ts";

const text =
	"Shared cache regression content has enough stable documentation prose for extraction, summary checks, and repeat fetch assertions.";

afterEach(() => setFetchTransportForTest(undefined));

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

function freshSeconds(cacheControl: string): number | undefined {
	const until = freshUntilFor({
		ok: true,
		status: 200,
		contentType: "text/html",
		cacheControl,
	} as Parameters<typeof freshUntilFor>[0]);
	// clamp to non-negative: a sub-millisecond tick between freshUntilFor's
	// internal Date.now() and this one can round to -0 for s-maxage=0.
	return until
		? Math.max(0, Math.round((until.getTime() - Date.now()) / 1000))
		: undefined;
}

function parsePageConfig(url: string): PipelineConfig {
	const parsed = parseArgs([url, "--page"]);
	if ("help" in parsed || "version" in parsed) {
		throw new Error("parseArgs returned help/version");
	}
	return buildPipelineConfig(parsed.run);
}

describe("cache freshness policy", () => {
	test.each([
		["s-maxage=0, max-age=600", 0],
		["max-age=600, s-maxage=0", 0],
		["max-age=600", 600],
		["s-maxage=300, max-age=600", 300],
	])("computes shared freshness for %s", (cacheControl, seconds) => {
		expect(freshSeconds(cacheControl)).toBe(seconds);
	});
});

describe("cache reuse across output directories", () => {
	test("second output directory reads from the shared cache", async () => {
		await withCacheEnv("cross-dir", async () => {
			const root = await mkdtemp(join(tmpdir(), "docsnap-cache-out-"));
			let pageCalls = 0;
			setFetchTransportForTest(async (input) => {
				const url = String(input);
				if (isRobots(url)) return robots404(url);
				pageCalls++;
				return response(url, 200, page("Shared Cache", text));
			});
			const first = await runPipeline(
				config("https://cache.example.com/page", root, "one"),
			);
			const second = await runPipeline(
				config("https://cache.example.com/page", root, "two"),
			);
			expect(first.summary.cache.written).toBe(1);
			expect(second.summary.cache.hits).toBe(1);
			expect(second.summary.cache.bytesRead).toBeGreaterThan(0);
			expect(pageCalls).toBe(1);
		});
	});
});

describe("stale cache revalidation", () => {
	test("stale entries revalidate with etag and keep cached markdown", async () => {
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
			await runPipeline(config("https://stale.example.com/page", root, "one"));
			const second = await runPipeline(
				config("https://stale.example.com/page", root, "two"),
			);
			expect(pageCalls).toBe(2);
			expect(seenHeaders[1]?.["if-none-match"]).toBe('"stale-v1"');
			expect(second.summary.cache.stale).toBe(1);
			expect(second.summary.cache.revalidated).toBe(1);
			expect(
				second.records.some(
					(record) => record.ok && record.markdown.includes(text),
				),
			).toBe(true);
		});
	});
});

describe.skipIf(sandboxNetworkDisabled())("cross-process cache", () => {
	test("separate docsnap processes share fresh and revalidated entries", async () => {
		await crossProcessCacheSmoke();
	});
});

describe("corrupt cache blobs", () => {
	test("corrupt blob is discarded and refetched", async () => {
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
			await runPipeline(
				config("https://corrupt.example.com/page", root, "one"),
			);
			const [blob] = await readdir(join(cacheDir, "blobs", "sha256"));
			expect(Boolean(blob)).toBe(true);
			await writeFile(join(cacheDir, "blobs", "sha256", blob!), "corrupt body");
			const second = await runPipeline(
				config("https://corrupt.example.com/page", root, "two"),
			);
			expect(pageCalls).toBe(2);
			expect(second.summary.cache.misses).toBe(1);
			expect(
				second.records.some(
					(record) => record.ok && record.markdown.includes("version 2"),
				),
			).toBe(true);
		});
	});
});

describe("disabled cache", () => {
	test("--no-cache skips reads and writes", async () => {
		await withCacheEnv("no-cache", async (cacheDir) => {
			const root = await mkdtemp(join(tmpdir(), "docsnap-cache-off-"));
			let pageCalls = 0;
			setFetchTransportForTest(async (input) => {
				const url = String(input);
				if (isRobots(url)) return robots404(url);
				pageCalls++;
				return response(url, 200, page("No Cache", text));
			});
			const first = await runPipeline(
				config("https://nocache.example.com/page", root, "one", ["--no-cache"]),
			);
			const second = await runPipeline(
				config("https://nocache.example.com/page", root, "two", ["--no-cache"]),
			);
			expect(first.summary.cache.enabled).toBeFalsy();
			expect(second.summary.cache.enabled).toBeFalsy();
			expect(pageCalls).toBe(2);
			expect(await countEntries(cacheDir)).toBe(0);
		});
	});
});

describe("cache size eviction", () => {
	test("cache max evicts written bytes", async () => {
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
				expect(result.summary.cache.written).toBe(1);
				expect(result.summary.cache.evictedBytes).toBeGreaterThan(0);
			} finally {
				delete process.env[cacheMaxEnv];
			}
		});
	});
});

describe("clean output reuse", () => {
	test("same output directory reuses one cache entry", async () => {
		await withCacheEnv("clean", async (cacheDir) => {
			const root = await mkdtemp(join(tmpdir(), "docsnap-cache-clean-"));
			let pageCalls = 0;
			setFetchTransportForTest(async (input) => {
				const url = String(input);
				if (isRobots(url)) return robots404(url);
				pageCalls++;
				return response(url, 200, page("Clean", text));
			});
			await runPipeline(config("https://clean.example.com/page", root, "same"));
			expect(await countEntries(cacheDir)).toBe(1);
			const second = await runPipeline(
				config("https://clean.example.com/page", root, "same"),
			);
			expect(pageCalls).toBe(1);
			expect(second.summary.cache.hits).toBe(1);
			expect(await countEntries(cacheDir)).toBe(1);
		});
	});
});

describe("cache request locking", () => {
	test("parallel fetches coordinate through the cache lock", async () => {
		await withCacheEnv("lock", async () => {
			let calls = 0;
			const parsed = parsePageConfig("https://lock.example.com/page");
			setFetchTransportForTest(async (input) => {
				calls++;
				await Bun.sleep(40);
				return response(String(input), 200, page("Lock", text));
			});
			const [one, two] = await Promise.all([
				fetchText("https://lock.example.com/page", parsed),
				fetchText("https://lock.example.com/page", parsed),
			]);
			expect(one.ok && two.ok).toBe(true);
			expect(calls).toBeLessThanOrEqual(2);
			const before = calls;
			const third = await fetchText("https://lock.example.com/page", parsed);
			expect(third.ok).toBe(true);
			expect(calls).toBe(before);
		});
	});
});

describe("cache single-flight", () => {
	test("concurrent fetches share one upstream request and cached result", async () => {
		await withCacheEnv("single-flight", async (cacheDir) => {
			let calls = 0;
			const url = "https://single-flight.example.com/page";
			const parsed = parsePageConfig(url);
			setFetchTransportForTest(async (input) => {
				calls++;
				await Bun.sleep(400);
				return response(String(input), 200, page("SingleFlight", text), {
					"cache-control": "max-age=60",
				});
			});
			const [one, two, three] = await Promise.all([
				fetchText(url, parsed),
				fetchText(url, parsed),
				fetchText(url, parsed),
			]);
			expect(one.ok && two.ok && three.ok).toBe(true);
			expect(calls).toBe(1);
			expect(await countEntries(cacheDir)).toBe(1);
			const after = await fetchText(url, parsed);
			expect(after.ok).toBe(true);
			expect(calls).toBe(1);
		});
	});
});

describe("live cache locks", () => {
	test("live lock owner is not reaped", async () => {
		await withCacheEnv("live-lock-not-reaped", async (cacheDir) => {
			const url = "https://live-lock.example.com/page";
			const parsed = parsePageConfig(url);
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
			expect(lock).toBe(undefined);
			const owner = JSON.parse(
				await readFile(join(lockDir, dirLockOwnerFile), "utf8"),
			) as { token?: string };
			expect(owner.token).toBe("live-cache");
		});
	});
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
		expect(first.written).toBeGreaterThanOrEqual(3);
		expect(first.cache.written).toBeGreaterThanOrEqual(3);
		expect(second.cache.hits).toBeGreaterThanOrEqual(1);
		expect(second.cache.stale).toBeGreaterThanOrEqual(1);
		expect(second.cache.revalidated).toBeGreaterThanOrEqual(1);
		expect(second.cache.bytesRead).toBeGreaterThan(0);
		expect(freshRequests).toBe(1);
		expect(staleRequests).toBe(2);
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
	expect(exitCode).toBe(0);
	expect(stderr.trim()).toBe("");
	const cliJson = JSON.parse(stdout) as CliSummary;
	const summary = JSON.parse(
		await readFile(join(outDir, "summary.json"), "utf8"),
	) as CliSummary;
	expect(cliJson.cache.written).toBe(summary.cache.written);
	expect(cliJson.cache.hits).toBe(summary.cache.hits);
	expect(cliJson.cache.revalidated).toBe(summary.cache.revalidated);
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
