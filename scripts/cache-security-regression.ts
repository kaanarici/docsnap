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
import { pruneCache } from "../src/cache/eviction.ts";
import { cacheKey, cacheRequest, cacheSummary } from "../src/cache/store.ts";
import { parseArgs } from "../src/cli/args.ts";
import { runPipeline } from "../src/core/pipeline.ts";
import type { Config } from "../src/core/types.ts";
import { fetchText, setFetchTransportForTest } from "../src/fetch/fetcher.ts";
import { callTool } from "../src/mcp/tools.ts";

const cacheDirEnv = "DOCSNAP_CACHE_DIR";
const cacheMaxEnv = "DOCSNAP_CACHE_MAX_MB";
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

function config(
	url: string,
	root: string,
	name: string,
	extra: string[] = [],
	pageOnly = true,
): Config {
	const args = [
		url,
		"-o",
		join(root, name),
		"--clean",
		"--quiet",
		"--render",
		"never",
		...extra,
	];
	if (pageOnly) args.push("--page");
	const parsed = parseArgs(args);
	assertConfig(parsed);
	return parsed;
}

async function withCacheEnv(
	name: string,
	run: (cacheDir: string) => Promise<void>,
) {
	const previousDir = process.env[cacheDirEnv];
	const previousMax = process.env[cacheMaxEnv];
	const cacheDir = await mkdtemp(
		join(tmpdir(), `docsnap-cache-security-${name}-`),
	);
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
	setCookies: readonly string[] = [],
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
			getSetCookie: () => [...setCookies],
		},
		body: new TextEncoder().encode(body),
	};
}

function page(title: string, body: string) {
	return `<html><head><title>${title}</title></head><body><main><h1>${title}</h1><p>${body}</p></main></body></html>`;
}

function toolJson(value: unknown) {
	const result = value as { content: Array<{ text: string }> };
	return JSON.parse(result.content[0]?.text ?? "{}") as { ok?: boolean };
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
