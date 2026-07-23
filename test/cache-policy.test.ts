import { afterEach, describe, expect, test } from "bun:test";
import { freshUntilFor } from "../src/cache/policy.ts";
import { cacheRequest, readCache } from "../src/cache/store.ts";
import { okFetch, tempDir, testConfig } from "./fixtures.ts";

const cacheDirEnv = "DOCSNAP_CACHE_DIR";
const priorCacheDir = process.env[cacheDirEnv];

afterEach(() => {
	if (priorCacheDir === undefined) delete process.env[cacheDirEnv];
	else process.env[cacheDirEnv] = priorCacheDir;
});

describe("cache key composition", () => {
	test("includes normalized URL, accept, User-Agent, schema, and render mode", async () => {
		process.env[cacheDirEnv] = await tempDir("cache-keys");
		const config = testConfig("unused", { cache: true });
		const key = async (url: string, accept: string, userAgent: string) =>
			(
				await readCache(
					{ ...config, userAgent },
					cacheRequest(url, { ...config, userAgent }, accept),
					{ count: false },
				)
			).key;
		expect(
			await key("https://docs.example.com/page#one", "text/html", "agent-a"),
		).toBe(
			await key("https://docs.example.com/page#two", "text/html", "agent-a"),
		);
		expect(
			await key("https://docs.example.com/page", "text/html", "agent-a"),
		).not.toBe(
			await key("https://docs.example.com/page", "text/plain", "agent-a"),
		);
		expect(
			await key("https://docs.example.com/page", "text/html", "agent-a"),
		).not.toBe(
			await key("https://docs.example.com/page", "text/html", "agent-b"),
		);
	});
});

describe("shared-cache exclusions", () => {
	test.each([
		{ cacheControl: "no-store" },
		{ cacheControl: "private, max-age=60" },
		{ cacheControl: "no-cache" },
		{ setCookie: true },
		{ vary: "*" },
		{ vary: "Accept, Cookie" },
		{ vary: "Authorization" },
	])("does not cache $cacheControl$vary responses", (headers) => {
		expect(
			freshUntilFor(okFetch("https://docs.example.com/page", "body", headers)),
		).toBeUndefined();
	});

	test("uses explicit shared freshness for ordinary public content", () => {
		expect(
			freshUntilFor(
				okFetch("https://docs.example.com/page", "body", {
					cacheControl: "s-maxage=60, max-age=600",
				}),
			),
		).toBeInstanceOf(Date);
	});
});
