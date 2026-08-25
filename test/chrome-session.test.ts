import { expect, test } from "bun:test";
import type { PageRecord } from "../src/core/types.ts";
import {
	chromeStopped,
	createChromeSession,
	maxConsecutiveRenderMisses,
	needsChrome,
	needsChromeFetch,
	skipChrome,
} from "../src/render/session.ts";
import { okFetch } from "./fixtures.ts";

test("selects Chrome from app-shell kind and empty shell failures", () => {
	const shell = success({ kind: "app-shell" });
	expect(needsChrome(shell, false)).toBe(true);
	expect(needsChrome(success({ kind: "docs-html" }), true)).toBe(false);
	expect(needsChrome(success(), true)).toBe(true);
	expect(needsChrome(failure("empty"), true)).toBe(true);
	expect(needsChrome(failure("empty"), false)).toBe(false);
	expect(needsChrome(failure("blocked"), true)).toBe(false);
});

test("queues Chrome for fetched app shells using the same kind classifier", () => {
	const url = "https://docs.example.com/app";
	expect(
		needsChromeFetch(
			okFetch(
				url,
				`<html><head><title>Docs</title></head><body><div id="__next"></div><script src="/app.js"></script></body></html>`,
			),
		),
	).toBe(true);
	expect(
		needsChromeFetch(
			okFetch(
				url,
				`<html><body><main><h1>Install</h1><p>Run the capture command against a public documentation site.</p></main></body></html>`,
			),
		),
	).toBe(false);
});

test("shares the miss budget used by pipeline and map", () => {
	const session = createChromeSession();
	expect(chromeStopped(session)).toBe(false);
	session.misses = maxConsecutiveRenderMisses;
	expect(chromeStopped(session)).toBe(true);
	skipChrome(session, 4, "no_recovery");
	expect(session).toMatchObject({
		skipped: 4,
		truncated: true,
		stopReason: "no_recovery",
	});
});

function success(
	overrides: Partial<Extract<PageRecord, { ok: true }>> = {},
): PageRecord {
	return {
		ok: true,
		url: "https://docs.example.com/app",
		finalUrl: "https://docs.example.com/app",
		status: 200,
		source: "seed",
		redirects: [],
		fetchedAt: "2026-01-01T00:00:00.000Z",
		injectionSignals: [],
		markdown: "content",
		links: [],
		contentHash: "hash",
		extractor: "inline-state",
		qualityReasons: [],
		...overrides,
	};
}

function failure(
	failureKind: Extract<PageRecord, { ok: false }>["failureKind"],
): PageRecord {
	return {
		ok: false,
		url: "https://docs.example.com/app",
		finalUrl: "https://docs.example.com/app",
		status: 200,
		source: "seed",
		redirects: [],
		fetchedAt: "2026-01-01T00:00:00.000Z",
		injectionSignals: [],
		markdown: "",
		links: [],
		contentHash: "",
		extractor: "none",
		qualityReasons: [],
		error: "app shell without static text",
		failureKind,
	};
}
