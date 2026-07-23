import { afterEach, describe, expect, test } from "bun:test";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
	fetchWithCache,
	type UncachedFetch,
} from "../src/cache/cached-fetch.ts";
import type { FetchResult } from "../src/core/types.ts";
import { okFetch, tempDir, testConfig } from "./fixtures.ts";

const cacheDirEnv = "DOCSNAP_CACHE_DIR";
const priorCacheDir = process.env[cacheDirEnv];
const url = "https://cache.example.com/page";
const accept = "text/html";

afterEach(() => {
	if (priorCacheDir === undefined) delete process.env[cacheDirEnv];
	else process.env[cacheDirEnv] = priorCacheDir;
});

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
});

async function primeCache(body: string) {
	const cacheDir = await tempDir("cache-revalidate");
	process.env[cacheDirEnv] = cacheDir;
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
	const entry = JSON.parse(await readFile(path, "utf8")) as {
		freshUntil: string;
	};
	entry.freshUntil = "2000-01-01T00:00:00.000Z";
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
		fetchMs: 1,
		redirects: [],
		fetchedAt: "2026-01-01T00:00:00.000Z",
		cacheControl: "max-age=60",
	};
}
