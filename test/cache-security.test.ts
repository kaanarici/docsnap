import { describe, expect, test } from "bun:test";
import {
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, parse } from "node:path";
import {
	cacheDirEnv,
	cacheMaxEnv,
	config,
	countEntries,
	page,
	response,
	withCacheEnv,
} from "../scripts/cache-fixtures.ts";
import { pruneCache } from "../src/cache/eviction.ts";
import {
	acquireCacheLock,
	cacheContext,
	cacheKey,
	cacheRequest,
	cacheSummary,
	parseEntry,
	refreshCacheEntry,
	writeCacheResult,
} from "../src/cache/store.ts";
import { buildPipelineConfig, parseArgs } from "../src/cli/args.ts";
import { releaseDirLock } from "../src/core/dir-lock.ts";
import { runPipeline } from "../src/core/pipeline.ts";
import type { FetchResult, PipelineConfig } from "../src/core/types.ts";
import { fetchText, setFetchTransportForTest } from "../src/fetch/fetcher.ts";
import { callTool } from "../src/mcp/tools.ts";

const prose =
	"Cache security regression prose is long enough to be extracted as a stable documentation page for assertions.";

function expectConfig(value: ReturnType<typeof parseArgs>): PipelineConfig {
	if ("help" in value || "version" in value) {
		throw new Error("parseArgs returned help/version");
	}
	return buildPipelineConfig(value.run);
}

function toolJson(value: unknown) {
	const result = value as { content: Array<{ text: string }> };
	return JSON.parse(result.content[0]?.text ?? "{}") as { ok?: boolean };
}

describe("cache respects robots changes", () => {
	test("fresh robots rules gate cached discovery results", async () => {
		await withCacheEnv("robots-fresh", async () => {
			const root = await mkdtemp(join(tmpdir(), "docsnap-robots-fresh-"));
			let robotsCalls = 0;
			let privateCalls = 0;
			setFetchTransportForTest(async (input) => {
				const url = String(input);
				if (url === "https://robotcache.example/robots.txt") {
					robotsCalls++;
					const rule = robotsCalls === 1 ? "Allow: /" : "Disallow: /docs/x";
					return response(url, 200, `User-agent: *\n${rule}\n`, {
						"content-type": "text/plain",
					});
				}
				if (url.endsWith("/llms.txt")) {
					return response(url, 404, "not found", {
						"content-type": "text/plain",
					});
				}
				if (url === "https://robotcache.example/docs/") {
					return response(
						url,
						200,
						page("Seed", `<a href="/docs/x">Private docs</a><p>${prose}</p>`),
					);
				}
				if (url === "https://robotcache.example/docs/x") {
					privateCalls++;
					return response(url, 200, page("Private", prose));
				}
				return response(url, 404, "not found", {
					"content-type": "text/plain",
				});
			});
			try {
				const first = await runPipeline(
					config(
						"https://robotcache.example/docs/",
						root,
						"one",
						["-m", "2"],
						false,
					),
				);
				const second = await runPipeline(
					config(
						"https://robotcache.example/docs/",
						root,
						"two",
						["-m", "2"],
						false,
					),
				);
				expect(
					first.records.some((record) => record.url.endsWith("/docs/x")),
				).toBeTruthy();
				expect(
					second.records.some((record) => record.url.endsWith("/docs/x")),
				).toBe(false);
				expect(robotsCalls).toBe(2);
				expect(privateCalls).toBe(1);
				expect(second.summary.cache.hits).toBeGreaterThan(0);
			} finally {
				setFetchTransportForTest(undefined);
				await rm(root, { recursive: true, force: true });
			}
		});
	});

	test("page fetches stay blocked by robots unless explicitly ignored", async () => {
		await withCacheEnv("page-robots", async () => {
			const root = await mkdtemp(join(tmpdir(), "docsnap-page-robots-"));
			let pageFetches = 0;
			let robotsFetches = 0;
			setFetchTransportForTest(async (input) => {
				const url = String(input);
				if (url === "https://pagegate.example/robots.txt") {
					robotsFetches++;
					return response(url, 200, "User-agent: *\nDisallow: /private\n", {
						"content-type": "text/plain",
					});
				}
				if (url === "https://pagegate.example/private") {
					pageFetches++;
					return response(url, 200, page("Private", prose));
				}
				return response(url, 404, "not found", {
					"content-type": "text/plain",
				});
			});
			try {
				const blocked = await runPipeline(
					config("https://pagegate.example/private", root, "blocked"),
				);
				expect(blocked.summary.written).toBe(0);
				expect(blocked.summary.byFailureKind.blocked).toBe(1);
				const blockedRecord = blocked.records[0];
				expect(blockedRecord?.ok).toBe(false);
				if (!blockedRecord || blockedRecord.ok) {
					throw new Error("expected blocked record");
				}
				expect(blockedRecord.failureKind).toBe("blocked");
				expect(pageFetches).toBe(0);
				expect(robotsFetches).toBe(1);

				pageFetches = 0;
				const ignored = await runPipeline(
					config("https://pagegate.example/private", root, "ignored", [
						"--ignore-robots",
					]),
				);
				expect(ignored.summary.written).toBe(1);
				expect(pageFetches).toBe(1);
				expect(robotsFetches).toBe(1);
			} finally {
				setFetchTransportForTest(undefined);
				await rm(root, { recursive: true, force: true });
			}
		});
	});

	test("MCP capture also honors page-level robots blocks", async () => {
		await withCacheEnv("mcp-page-robots", async () => {
			const root = await mkdtemp(join(tmpdir(), "docsnap-mcp-page-robots-"));
			let pageFetches = 0;
			setFetchTransportForTest(async (input) => {
				const url = String(input);
				if (url === "https://mcppage.example/robots.txt") {
					return response(url, 200, "User-agent: *\nDisallow: /private\n", {
						"content-type": "text/plain",
					});
				}
				if (url === "https://mcppage.example/private") {
					pageFetches++;
					return response(url, 200, page("Private", prose));
				}
				return response(url, 404, "not found", {
					"content-type": "text/plain",
				});
			});
			const cwd0 = process.cwd();
			process.chdir(root);
			try {
				const outDir = join(root, "capture");
				const result = toolJson(
					await callTool(
						"docsnap_capture",
						{
							url: "https://mcppage.example/private",
							output_dir: outDir,
							page_only: true,
							clean: true,
						},
						{ corpora: new Set(), resourceCorpora: new Map() },
					),
				);
				const summary = JSON.parse(
					await readFile(join(outDir, "summary.json"), "utf8"),
				);
				expect(result.ok).toBe(false);
				expect(summary.byFailureKind.blocked).toBe(1);
				expect(pageFetches).toBe(0);
			} finally {
				process.chdir(cwd0);
				setFetchTransportForTest(undefined);
				await rm(root, { recursive: true, force: true });
			}
		});
	});
});

describe("cache storage policy rejects unsafe responses", () => {
	test.each([
		{
			name: "no-cache",
			headers: { "cache-control": "no-cache, max-age=600" },
		},
		{
			name: "private",
			headers: { "cache-control": "private, max-age=600" },
		},
		{ name: "vary-star", headers: { vary: "*" } },
		{ name: "vary-cookie", headers: { vary: "Accept-Encoding, Cookie" } },
		{ name: "vary-authorization", headers: { vary: "Authorization" } },
		{ name: "set-cookie", headers: {}, setCookies: ["sid=secret; HttpOnly"] },
	] as const)("$name responses are not written to cache", async ({
		name,
		headers,
		setCookies,
	}) => {
		await withCacheEnv(`policy-${name}`, async (cacheDir) => {
			const root = await mkdtemp(join(tmpdir(), `docsnap-cache-${name}-`));
			let pageFetches = 0;
			setFetchTransportForTest(async (input) => {
				const url = String(input);
				if (url.endsWith("/robots.txt")) {
					return response(url, 404, "not found", {
						"content-type": "text/plain",
					});
				}
				pageFetches++;
				return response(
					url,
					200,
					page(name, `${prose} ${pageFetches}`),
					headers,
					setCookies,
				);
			});
			try {
				const first = await runPipeline(
					config(`https://${name}.example/page`, root, "one"),
				);
				const second = await runPipeline(
					config(`https://${name}.example/page`, root, "two"),
				);
				expect(first.summary.cache.written).toBe(0);
				expect(second.summary.cache.written).toBe(0);
				expect(pageFetches).toBe(2);
				expect(await countEntries(cacheDir)).toBe(0);
			} finally {
				setFetchTransportForTest(undefined);
				await rm(root, { recursive: true, force: true });
			}
		});
	});
});

describe("cache filesystem safety", () => {
	test("tampered blob paths do not escape eviction", async () => {
		await withCacheEnv("tampered-eviction", async (cacheDir) => {
			const root = await mkdtemp(join(tmpdir(), "docsnap-tampered-cache-"));
			process.env[cacheMaxEnv] = "0.000001";
			try {
				const outside = join(root, "outside.txt");
				const key = "a".repeat(64);
				const now = new Date().toISOString();
				await mkdir(join(cacheDir, "entries"), { recursive: true });
				await mkdir(join(cacheDir, "blobs", "sha256"), { recursive: true });
				await writeFile(outside, "keep");
				await writeFile(
					join(cacheDir, "entries", `${key}.json`),
					`${JSON.stringify({
						schemaVersion: "docsnap-cache-v1",
						key,
						requestUrl: "https://tamper.example/page",
						finalUrl: "https://tamper.example/page",
						status: 200,
						contentType: "text/html",
						redirects: [],
						fetchedAt: now,
						cachedAt: now,
						freshUntil: now,
						bodyHash: "../../../outside.txt",
						bytes: 10_000,
					})}\n`,
				);
				const parsed = expectConfig(
					parseArgs(["https://tamper.example/page", "--page"]),
				);
				await pruneCache(parsed);
				expect(await readFile(outside, "utf8")).toBe("keep");
			} finally {
				delete process.env[cacheMaxEnv];
				await rm(root, { recursive: true, force: true });
			}
		});
	});

	test("stale cache locks can be recovered and replaced", async () => {
		await withCacheEnv("stale-lock", async (cacheDir) => {
			const url = "https://stalelock.example/page";
			const accept = "text/html";
			const parsed = expectConfig(parseArgs([url, "--page"]));
			const key = cacheKey(cacheRequest(url, parsed, accept));
			const lockDir = join(cacheDir, "locks", `${key}.lock`);
			await mkdir(lockDir, { recursive: true });
			await writeFile(
				join(lockDir, "owner.json"),
				`${JSON.stringify({
					pid: 999_999,
					token: "stale",
					createdAt: new Date(Date.now() - 120_000).toISOString(),
				})}\n`,
			);
			let pageFetches = 0;
			setFetchTransportForTest(async (input) => {
				pageFetches++;
				return response(String(input), 200, page("Stale Lock", prose));
			});
			try {
				const result = await fetchText(url, parsed, accept);
				expect(result.ok).toBe(true);
				expect(pageFetches).toBe(1);
				expect(cacheSummary(parsed).written).toBe(1);
				expect(await countEntries(cacheDir)).toBe(1);
			} finally {
				setFetchTransportForTest(undefined);
			}
		});
	});

	test("unsafe DOCSNAP_CACHE_DIR values disable cache without managing home paths", async () => {
		const previous = process.env[cacheDirEnv];
		const linkBase = await mkdtemp(join(tmpdir(), "docsnap-cache-unsafe-"));
		const symlinkToHome = join(linkBase, "looks-safe");
		await symlink(homedir(), symlinkToHome);
		try {
			for (const dir of [
				parse(homedir()).root,
				homedir(),
				join(homedir(), "Documents"),
				symlinkToHome,
			]) {
				process.env[cacheDirEnv] = dir;
				const parsed = expectConfig(
					parseArgs(["https://unsafe-root.example/page", "--page"]),
				);
				const ctx = cacheContext(parsed);
				expect(ctx.enabled).toBe(false);
				expect(ctx.dir).toBe(null);
			}
			process.env[cacheDirEnv] = linkBase;
			const safe = expectConfig(
				parseArgs(["https://safe-root.example/page", "--page"]),
			);
			expect(cacheContext(safe).enabled).toBe(true);
			process.env[cacheDirEnv] = join(
				homedir(),
				"docsnap-cache-fresh-nonexistent",
			);
			const fresh = expectConfig(
				parseArgs(["https://fresh-root.example/page", "--page"]),
			);
			expect(cacheContext(fresh).enabled).toBe(true);
		} finally {
			if (previous === undefined) delete process.env[cacheDirEnv];
			else process.env[cacheDirEnv] = previous;
			await rm(linkBase, { recursive: true, force: true });
		}
	});
});

describe("cache blobs stay content-addressed", () => {
	test("rewrites unlink only orphaned blobs", async () => {
		await withCacheEnv("orphan-blob", async (cacheDir) => {
			const accept = "text/html";
			const blobsDir = join(cacheDir, "blobs", "sha256");
			const longBody = (tag: string) =>
				`${prose} Orphan-blob regression body variant ${tag} with stable prose.`;
			const result = (url: string, body: string): FetchResult => ({
				url,
				finalUrl: url,
				status: 200,
				contentType: "text/html",
				body,
				fetchMs: 1,
				redirects: [],
				cacheControl: "max-age=600",
				fetchedAt: new Date().toISOString(),
				ok: true,
			});
			const put = async (url: string, body: string) => {
				const parsed = expectConfig(parseArgs([url, "--page"]));
				const request = cacheRequest(url, parsed, accept);
				const key = cacheKey(request);
				const lock = await acquireCacheLock(parsed, key);
				expect(lock).not.toBeUndefined();
				if (lock === undefined) throw new Error("cache lock not acquired");
				try {
					await writeCacheResult(parsed, key, request, result(url, body));
				} finally {
					await releaseDirLock(lock);
				}
			};

			const urlA = "https://orphan.example/a";
			const urlB = "https://orphan.example/b";
			await put(urlA, longBody("one"));
			await put(urlA, longBody("two"));
			expect(await readdir(blobsDir)).toHaveLength(1);

			const shared = longBody("shared");
			await put(urlA, shared);
			await put(urlB, shared);
			expect(await readdir(blobsDir)).toHaveLength(1);
			await put(urlA, longBody("after-shared"));
			expect(await readdir(blobsDir)).toHaveLength(2);

			const parsedB = expectConfig(parseArgs([urlB, "--page"]));
			const requestB = cacheRequest(urlB, parsedB, accept);
			const keyB = cacheKey(requestB);
			const lockB = await acquireCacheLock(parsedB, keyB);
			expect(lockB).not.toBeUndefined();
			if (lockB === undefined) throw new Error("refresh lock not acquired");
			try {
				const entryB = parseEntry(
					await readFile(join(cacheDir, "entries", `${keyB}.json`), "utf8"),
					keyB,
				);
				expect(entryB).not.toBeUndefined();
				if (entryB === undefined) {
					throw new Error("urlB entry present before refresh");
				}
				await refreshCacheEntry(parsedB, keyB, entryB, {
					...result(urlB, ""),
					setCookie: true,
				});
			} finally {
				await releaseDirLock(lockB);
			}
			expect(await countEntries(cacheDir)).toBe(1);
			expect(await readdir(blobsDir)).toHaveLength(1);
		});
	});
});
