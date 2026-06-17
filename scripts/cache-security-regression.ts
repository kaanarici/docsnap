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
import { parseArgs } from "../src/cli/args.ts";
import { releaseDirLock } from "../src/core/dir-lock.ts";
import { runPipeline } from "../src/core/pipeline.ts";
import type { FetchResult } from "../src/core/types.ts";
import { fetchText, setFetchTransportForTest } from "../src/fetch/fetcher.ts";
import { callTool } from "../src/mcp/tools.ts";
import {
	assert,
	assertConfig,
	cacheDirEnv,
	cacheMaxEnv,
	config,
	countEntries,
	page,
	response,
	withCacheEnv,
} from "./cache-fixtures.ts";

const prose =
	"Cache security regression prose is long enough to be extracted as a stable documentation page for assertions.";

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
			return response(url, 404, "not found", { "content-type": "text/plain" });
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
		return response(url, 404, "not found", { "content-type": "text/plain" });
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
		assert(first.records.some((record) => record.url.endsWith("/docs/x")));
		assert(!second.records.some((record) => record.url.endsWith("/docs/x")));
		assert(robotsCalls === 2);
		assert(privateCalls === 1);
		assert(second.summary.cache.hits > 0);
	} finally {
		setFetchTransportForTest(undefined);
		await rm(root, { recursive: true, force: true });
	}
});

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
		return response(url, 404, "not found", { "content-type": "text/plain" });
	});
	try {
		const blocked = await runPipeline(
			config("https://pagegate.example/private", root, "blocked"),
		);
		assert(blocked.summary.written === 0);
		assert(blocked.summary.byFailureKind.blocked === 1);
		assert(blocked.records[0]?.ok === false);
		assert(blocked.records[0].failureKind === "blocked");
		assert(pageFetches === 0);
		assert(robotsFetches === 1);

		pageFetches = 0;
		const ignored = await runPipeline(
			config("https://pagegate.example/private", root, "ignored", [
				"--ignore-robots",
			]),
		);
		assert(ignored.summary.written === 1);
		assert(pageFetches === 1);
		assert(robotsFetches === 1);
	} finally {
		setFetchTransportForTest(undefined);
		await rm(root, { recursive: true, force: true });
	}
});

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
		return response(url, 404, "not found", { "content-type": "text/plain" });
	});
	// the MCP server only writes under its cwd; capture from the workspace root
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
		assert(result.ok === false);
		assert(summary.byFailureKind.blocked === 1);
		assert(pageFetches === 0);
	} finally {
		process.chdir(cwd0);
		setFetchTransportForTest(undefined);
		await rm(root, { recursive: true, force: true });
	}
});

for (const item of [
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
] as const) {
	await withCacheEnv(`policy-${item.name}`, async (cacheDir) => {
		const root = await mkdtemp(join(tmpdir(), `docsnap-cache-${item.name}-`));
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
				page(item.name, `${prose} ${pageFetches}`),
				item.headers,
				item.setCookies,
			);
		});
		try {
			const first = await runPipeline(
				config(`https://${item.name}.example/page`, root, "one"),
			);
			const second = await runPipeline(
				config(`https://${item.name}.example/page`, root, "two"),
			);
			assert(first.summary.cache.written === 0);
			assert(second.summary.cache.written === 0);
			assert(pageFetches === 2);
			assert((await countEntries(cacheDir)) === 0);
		} finally {
			setFetchTransportForTest(undefined);
			await rm(root, { recursive: true, force: true });
		}
	});
}

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
		const parsed = parseArgs(["https://tamper.example/page", "--page"]);
		assertConfig(parsed);
		await pruneCache(parsed);
		assert((await readFile(outside, "utf8")) === "keep");
	} finally {
		delete process.env[cacheMaxEnv];
		await rm(root, { recursive: true, force: true });
	}
});

await withCacheEnv("stale-lock", async (cacheDir) => {
	const url = "https://stalelock.example/page";
	const accept = "text/html";
	const parsed = parseArgs([url, "--page"]);
	assertConfig(parsed);
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
		assert(result.ok);
		assert(pageFetches === 1);
		assert(cacheSummary(parsed).written === 1);
		assert((await countEntries(cacheDir)) === 1);
	} finally {
		setFetchTransportForTest(undefined);
	}
});

// An unsafe DOCSNAP_CACHE_DIR (filesystem root, $HOME, a protected $HOME child,
// or a symlink resolving to one) must disable the cache, not manage files inside
// the user's home tree. Mirrors the output-root safe-root rule.
{
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
			const parsed = parseArgs(["https://unsafe-root.example/page", "--page"]);
			assertConfig(parsed);
			const ctx = cacheContext(parsed);
			assert(!ctx.enabled, `unsafe cache root must disable cache: ${dir}`);
			assert(ctx.dir === null, `unsafe cache root must resolve null: ${dir}`);
		}
		process.env[cacheDirEnv] = linkBase;
		const safe = parseArgs(["https://safe-root.example/page", "--page"]);
		assertConfig(safe);
		assert(
			cacheContext(safe).enabled,
			"a normal temp cache root stays enabled",
		);
		// a fresh, not-yet-created path under $HOME is a SAFE root: symlink
		// resolution must not collapse it onto its nearest existing ancestor
		// ($HOME) and wrongly disable the cache
		process.env[cacheDirEnv] = join(
			homedir(),
			"docsnap-cache-fresh-nonexistent",
		);
		const fresh = parseArgs(["https://fresh-root.example/page", "--page"]);
		assertConfig(fresh);
		assert(
			cacheContext(fresh).enabled,
			"a fresh non-existent cache root under $HOME stays enabled",
		);
	} finally {
		if (previous === undefined) delete process.env[cacheDirEnv];
		else process.env[cacheDirEnv] = previous;
		await rm(linkBase, { recursive: true, force: true });
	}
}

// Replacing an entry's body must unlink the orphaned prior blob, but a blob that
// is still referenced by another cache key (content-addressed dedup) must NOT be
// removed. Also covers refresh-to-uncacheable, which drops the entry + blob.
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
		const parsed = parseArgs([url, "--page"]);
		assertConfig(parsed);
		const request = cacheRequest(url, parsed, accept);
		const key = cacheKey(request);
		const lock = await acquireCacheLock(parsed, key);
		assert(lock !== undefined, "cache lock acquired");
		try {
			await writeCacheResult(parsed, key, request, result(url, body));
		} finally {
			await releaseDirLock(lock);
		}
	};

	const urlA = "https://orphan.example/a";
	const urlB = "https://orphan.example/b";
	// Same URL re-fetched with a changed body: prior blob is orphaned -> removed.
	await put(urlA, longBody("one"));
	await put(urlA, longBody("two"));
	assert(
		(await readdir(blobsDir)).length === 1,
		"re-write removes orphan blob",
	);

	// A second key sharing the identical body must keep the shared blob alive.
	const shared = longBody("shared");
	await put(urlA, shared);
	await put(urlB, shared);
	assert((await readdir(blobsDir)).length === 1, "shared blob deduplicated");
	// Re-write urlA only; urlB still references the shared blob, so it survives.
	await put(urlA, longBody("after-shared"));
	assert(
		(await readdir(blobsDir)).length === 2,
		"shared blob kept while urlB references it",
	);

	// Refresh that becomes uncacheable drops the entry and its now-orphan blob.
	const parsedB = parseArgs([urlB, "--page"]);
	assertConfig(parsedB);
	const requestB = cacheRequest(urlB, parsedB, accept);
	const keyB = cacheKey(requestB);
	const lockB = await acquireCacheLock(parsedB, keyB);
	assert(lockB !== undefined, "refresh lock acquired");
	try {
		const entryB = parseEntry(
			await readFile(join(cacheDir, "entries", `${keyB}.json`), "utf8"),
			keyB,
		);
		assert(entryB !== undefined, "urlB entry present before refresh");
		await refreshCacheEntry(parsedB, keyB, entryB, {
			...result(urlB, ""),
			setCookie: true,
		});
	} finally {
		await releaseDirLock(lockB);
	}
	assert(
		(await countEntries(cacheDir)) === 1,
		"uncacheable refresh removes urlB entry",
	);
	assert(
		(await readdir(blobsDir)).length === 1,
		"uncacheable refresh removes urlB orphan blob",
	);
});

function toolJson(value: unknown) {
	const result = value as { content: Array<{ text: string }> };
	return JSON.parse(result.content[0]?.text ?? "{}") as { ok?: boolean };
}
