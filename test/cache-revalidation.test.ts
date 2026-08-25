import { describe, expect, test } from "bun:test";
import { chmod, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
	fetchWithCache,
	type UncachedFetch,
} from "../src/cache/cached-fetch.ts";
import { pruneCache } from "../src/cache/eviction.ts";
import { cacheSummary } from "../src/cache/store.ts";
import { isJsonObject, parseJsonValue } from "../src/core/json.ts";
import type { FetchResult } from "../src/core/types.ts";
import { okFetch, setTestEnv, tempDir, testConfig } from "./fixtures.ts";

const cacheDirEnv = "DOCSNAP_CACHE_DIR";
const cacheMaxEnv = "DOCSNAP_CACHE_MAX_MB";
const url = "https://cache.example.com/page";
const accept = "text/html";

describe("304 cache reuse", () => {
	test("reuses a hash-verified stale body after validation", async () => {
		const { cacheDir, config } = await primeCache("verified body");
		await expireEntry(cacheDir);
		let conditionalEtag: string | undefined;
		const uncached: UncachedFetch = async (
			_input,
			_config,
			_accept,
			conditional,
		) => {
			conditionalEtag = conditional?.etag;
			return notModified();
		};
		const result = await fetchWithCache(
			url,
			config,
			accept,
			undefined,
			uncached,
		);
		expect(conditionalEtag).toBe('"v1"');
		expect(result.ok && result.body).toBe("verified body");
	});

	test("refetches instead of reusing a body whose hash does not verify", async () => {
		const { cacheDir, config } = await primeCache("original body");
		await expireEntry(cacheDir);
		const blobDir = join(cacheDir, "blobs", "sha256");
		const [blob] = await readdir(blobDir);
		if (!blob) throw new Error("missing cache blob");
		await writeFile(join(blobDir, blob), "tampered body");
		let conditionalSeen = false;
		const uncached: UncachedFetch = async (
			_input,
			_config,
			_accept,
			conditional,
		) => {
			conditionalSeen = conditional !== undefined;
			return okFetch(url, "refetched body", {
				cacheControl: "max-age=60",
				etag: '"v2"',
			});
		};
		const result = await fetchWithCache(
			url,
			config,
			accept,
			undefined,
			uncached,
		);
		expect(conditionalSeen).toBe(false);
		expect(result.ok && result.body).toBe("refetched body");
	});

	test("rejects oversized entry metadata before parsing", async () => {
		const { cacheDir, config } = await primeCache("original body");
		const entriesDir = join(cacheDir, "entries");
		const [entryName] = await readdir(entriesDir);
		if (!entryName) throw new Error("missing cache entry");
		await writeFile(join(entriesDir, entryName), "x".repeat(65 * 1024));
		let refetched = false;
		const result = await fetchWithCache(
			url,
			config,
			accept,
			undefined,
			async () => {
				refetched = true;
				return okFetch(url, "refetched body");
			},
		);
		expect(refetched).toBe(true);
		expect(result.ok && result.body).toBe("refetched body");
	});

	test("keeps a recently read entry when enforcing the cache cap", async () => {
		const cacheDir = await tempDir("cache-lru");
		setTestEnv(cacheDirEnv, cacheDir);
		const initial = testConfig("unused", { cache: true });
		const otherUrl = `${url}-other`;
		for (const target of [url, otherUrl]) {
			await fetchWithCache(target, initial, accept, undefined, async () =>
				okFetch(target, target.repeat(128), { cacheControl: "max-age=60" }),
			);
			await Bun.sleep(2);
		}
		setTestEnv(cacheMaxEnv, "0.006");
		const capped = testConfig("unused", { cache: true });
		await fetchWithCache(url, capped, accept, undefined, async () => {
			throw new Error("cache hit unexpectedly fetched");
		});
		await pruneCache(capped);
		let fetched = false;
		await fetchWithCache(otherUrl, capped, accept, undefined, async () => {
			fetched = true;
			return okFetch(otherUrl, "refetched", { cacheControl: "no-store" });
		});
		expect(fetched).toBe(true);
		expect(await readdir(join(cacheDir, "entries"))).toHaveLength(1);
	});

	test("rejects cache content from a shared root", async () => {
		const { cacheDir } = await primeCache("attacker-controlled body");
		await chmod(cacheDir, 0o777);
		const config = testConfig("unused", { cache: true });
		const result = await fetchWithCache(
			url,
			config,
			accept,
			undefined,
			async () => okFetch(url, "trusted body", { cacheControl: "no-store" }),
		);
		expect(result.ok && result.body).toBe("trusted body");
		expect(cacheSummary(config).enabled).toBe(false);
	});

	test("creates private cache directories and files", async () => {
		const parent = await tempDir("cache-modes");
		const cacheDir = join(parent, "cache");
		setTestEnv(cacheDirEnv, cacheDir);
		const config = testConfig("unused", { cache: true });
		await fetchWithCache(url, config, accept, undefined, async () =>
			okFetch(url, "private body", { cacheControl: "max-age=60" }),
		);
		for (const dir of [
			cacheDir,
			join(cacheDir, "entries"),
			join(cacheDir, "blobs"),
			join(cacheDir, "blobs", "sha256"),
			join(cacheDir, "locks"),
		]) {
			expect((await stat(dir)).mode & 0o777).toBe(0o700);
		}
		for (const dir of ["entries", join("blobs", "sha256")]) {
			for (const name of await readdir(join(cacheDir, dir))) {
				expect((await stat(join(cacheDir, dir, name))).mode & 0o777).toBe(
					0o600,
				);
			}
		}
	});
});

async function primeCache(body: string) {
	const cacheDir = await tempDir("cache-revalidate");
	setTestEnv(cacheDirEnv, cacheDir);
	const config = testConfig("unused", { cache: true });
	const first = await fetchWithCache(url, config, accept, undefined, async () =>
		okFetch(url, body, {
			cacheControl: "max-age=60",
			etag: '"v1"',
		}),
	);
	if (!first.ok) throw new Error(first.error);
	return { cacheDir, config };
}

async function expireEntry(cacheDir: string) {
	const entriesDir = join(cacheDir, "entries");
	const [entryName] = await readdir(entriesDir);
	if (!entryName) throw new Error("missing cache entry");
	const path = join(entriesDir, entryName);
	const entry = parseJsonValue(await readFile(path, "utf8"));
	if (!isJsonObject(entry)) throw new Error("invalid cache entry fixture");
	entry["freshUntil"] = "2000-01-01T00:00:00.000Z";
	await writeFile(path, `${JSON.stringify(entry, null, 2)}\n`);
}

function notModified(): FetchResult {
	return {
		ok: true,
		notModified: true,
		url,
		finalUrl: url,
		status: 304,
		contentType: "text/html",
		body: "",
		redirects: [],
		fetchedAt: "2026-01-01T00:00:00.000Z",
		cacheControl: "max-age=60",
	};
}
