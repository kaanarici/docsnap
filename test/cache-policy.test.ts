import { describe, expect, test } from "bun:test";
import { freshUntilFor } from "../src/cache/policy.ts";
import { cacheRequest, readCache } from "../src/cache/store.ts";
import { okFetch, setTestEnv, tempDir, testConfig } from "./fixtures.ts";

const cacheDirEnv = "DOCSNAP_CACHE_DIR";

describe("cache key composition", () => {
	test("keys normalized URL, accept, and User-Agent", async () => {
		setTestEnv(cacheDirEnv, await tempDir("cache-keys"));
		const config = testConfig("unused", { cache: true });
		const url = "https://docs.example.com/page";
		const key = async (url: string, accept: string, userAgent: string) =>
			(
				await readCache(
					{ ...config, userAgent },
					cacheRequest(url, { ...config, userAgent }, accept),
					{ count: false },
				)
			).key;
		const base = await key(url, "text/html", "agent-a");
		expect(await key(`${url}#one`, "text/html", "agent-a")).toBe(
			await key(`${url}#two`, "text/html", "agent-a"),
		);
		expect(await key(url, "text/plain", "agent-a")).not.toBe(base);
		expect(await key(url, "text/html", "agent-b")).not.toBe(base);
	});
});

describe("shared-cache exclusions", () => {
	test.each([
		{ reason: "no-store", cacheControl: "no-store" },
		{ reason: "private", cacheControl: "private, max-age=60" },
		{ reason: "no-cache", cacheControl: "no-cache" },
		{ reason: "Set-Cookie", setCookie: true },
		{ reason: "Vary wildcard", vary: "*" },
		{ reason: "Vary Cookie", vary: "Accept, Cookie" },
		{ reason: "Vary Authorization", vary: "Authorization" },
		{
			reason: "binary document",
			document: new Uint8Array([0x25, 0x50, 0x44, 0x46]),
		},
	])("does not cache $reason responses", ({ reason: _, ...headers }) => {
		expect(
			freshUntilFor(okFetch("https://docs.example.com/page", "body", headers)),
		).toBeUndefined();
	});

	test("uses explicit shared freshness for ordinary public content", () => {
		const freshUntil = freshUntilFor(
			okFetch("https://docs.example.com/page", "body", {
				cacheControl: "s-maxage=60, max-age=600",
			}),
		);
		const remainingMs = (freshUntil?.getTime() ?? 0) - Date.now();
		expect(remainingMs).toBeGreaterThan(59_000);
		expect(remainingMs).toBeLessThanOrEqual(60_000);
	});
});
