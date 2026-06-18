import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	sandboxNetworkDisabled,
	startLoopbackServer,
	type TestServer,
} from "../scripts/local-fixture.ts";
import { McpClient } from "../scripts/mcp-client.ts";

type ToolCallResult = {
	content: Array<{ type: string; text: string }>;
	isError?: boolean;
};
type Citation = {
	citation_id?: string;
	output_path?: string;
	content_hash?: string;
	line_start?: number;
	snippet?: string;
};
type FetchJson = {
	corpus?: {
		action?: string;
		scope?: string;
		output_dir?: string;
		written?: number;
		seed_url?: string;
	};
	question?: string;
	citation_count?: number;
	citations?: Citation[];
	top_pages?: Array<{ output_path?: string; url?: string }>;
	next_actions?: string[];
	[key: string]: unknown;
};

const fixtureText =
	"Hermetic docsnap_fetch fixture: the dependency array controls when an effect re-runs.";
let origin = "";
let pageHits = 0;
let fixture: TestServer | undefined;

const pages: Record<string, string> = {
	"/": page(
		"Fetch Fixture Home",
		`<p>${fixtureText} The home page links to the effect guide and the styling page.</p>
		<nav><a href="/guide/use-effect">Effects</a><a href="/guide/styling">Styling</a></nav>`,
	),
	"/guide/use-effect": page(
		"useEffect dependencies and cleanup",
		`<p>${fixtureText} Pass an empty dependency array to run an effect only once on mount.
		Return a cleanup function to tear the effect down before the next run.</p>`,
	),
	"/guide/styling": page(
		"Styling and layout",
		`<p>This page is about colors, spacing, and layout. It has nothing to do with effects.</p>`,
	),
};

describe.skipIf(sandboxNetworkDisabled())("docsnap_fetch MCP tool", () => {
	beforeAll(async () => {
		fixture = await startLoopbackServer(fixtureResponse);
		origin = fixture.origin;
	});

	afterAll(async () => {
		await fixture?.stop();
	});

	test("captures a small site and returns a ranked cited context pack", async () => {
		await withClient(async (client) => {
			const captured = await callFetch(client, {
				url: `${origin}/`,
				question: "how do I run an effect only once on mount",
				max_pages: 5,
			});
			expect(captured.corpus?.action).toBe("captured");
			expect(captured.corpus?.scope).toBe("site");
			expect(captured.corpus?.written ?? 0).toBeGreaterThanOrEqual(2);
			expect(captured.question).toBe(
				"how do I run an effect only once on mount",
			);
			expect(captured.citation_count ?? 0).toBeGreaterThan(0);
			const top = captured.citations?.[0];
			expect(top?.output_path?.includes("use-effect")).toBe(true);
			expect(
				typeof top?.citation_id === "string" && top.citation_id.includes("#L"),
			).toBe(true);
			expect(
				typeof top?.content_hash === "string" && top.content_hash.length > 0,
			).toBe(true);
			expect(
				top?.snippet?.includes("WEB-DERIVED CONTENT (UNTRUSTED DATA)"),
			).toBe(true);
			expect(top?.snippet?.includes("Source URL:")).toBe(true);
			const outputDir = captured.corpus?.output_dir ?? "";
			expect(outputDir.length).toBeGreaterThan(0);
			for (const file of [
				"summary.json",
				"manifest.jsonl",
				"AGENT_README.md",
			]) {
				await readFile(join(outputDir, file), "utf8");
			}
		});
	});

	test("reuses a fresh corpus without re-fetching the origin", async () => {
		await withClient(async (client) => {
			await callFetch(client, {
				url: `${origin}/`,
				question: "how do I run an effect only once on mount",
				max_pages: 5,
			});
			const hitsAfterCapture = pageHits;
			const reused = await callFetch(client, {
				url: `${origin}/`,
				question: "how do I clean up an effect",
				freshness: "reuse",
				max_pages: 5,
			});
			expect(reused.corpus?.action).toBe("reused");
			expect(pageHits).toBe(hitsAfterCapture);
			expect(reused.citation_count ?? 0).toBeGreaterThan(0);
		});
	});

	test("refresh re-runs the seed and returns navigation without a question", async () => {
		await withClient(async (client) => {
			await callFetch(client, {
				url: `${origin}/`,
				question: "how do I run an effect only once on mount",
				max_pages: 5,
			});
			const hitsAfterCapture = pageHits;
			const refreshed = await callFetch(client, {
				url: `${origin}/`,
				freshness: "refresh",
				max_pages: 5,
			});
			expect(refreshed.corpus?.action).toBe("refreshed");
			expect(pageHits).toBeGreaterThan(hitsAfterCapture);
			expect(refreshed.citation_count).toBeUndefined();
			expect(refreshed.top_pages?.length ?? 0).toBeGreaterThan(0);
			expect(refreshed.next_actions?.length ?? 0).toBeGreaterThan(0);
		});
	});

	test("scope page captures a single page with citations", async () => {
		await withClient(async (client) => {
			const single = await callFetch(client, {
				url: `${origin}/guide/use-effect`,
				scope: "page",
				question: "what does the dependency array do",
			});
			expect(single.corpus?.scope).toBe("page");
			expect(single.corpus?.written).toBe(1);
			expect(single.citation_count ?? 0).toBeGreaterThan(0);
		});
	});

	test("rejects output_dir outside the MCP server cwd", async () => {
		await withClient(async (client) => {
			const escaped = (await client.request("tools/call", {
				name: "docsnap_fetch",
				arguments: { url: `${origin}/`, output_dir: "../escape" },
			})) as ToolCallResult;
			expect(escaped.isError).toBe(true);
			expect(escaped.content[0]?.text ?? "").toContain(
				"under the MCP server cwd",
			);
		});
	});

	test("rejects unsafe localhost URLs", async () => {
		await withClient(async (client) => {
			const unsafe = (await client.request("tools/call", {
				name: "docsnap_fetch",
				arguments: { url: "http://localhost:1234" },
			})) as ToolCallResult;
			expect(unsafe.isError).toBe(true);
			expect(unsafe.content[0]?.text ?? "").toContain(
				"localhost URLs are not allowed",
			);
		});
	});
});

async function withClient<T>(
	fn: (client: McpClient) => Promise<T>,
): Promise<T> {
	const tmpRoot = await mkdtemp(join(tmpdir(), "docsnap-fetch-"));
	const client = new McpClient(origin, tmpRoot);
	try {
		await client.request("initialize", {
			protocolVersion: "2025-06-18",
			capabilities: {},
			clientInfo: { name: "docsnap-fetch-regression", version: "0.0.0" },
		});
		client.notify("notifications/initialized", {});
		return await fn(client);
	} finally {
		await client.stop();
		await rm(tmpRoot, { recursive: true, force: true });
	}
}

async function callFetch(
	client: McpClient,
	args: Record<string, unknown>,
): Promise<FetchJson> {
	const result = (await client.request("tools/call", {
		name: "docsnap_fetch",
		arguments: args,
	})) as ToolCallResult;
	const text = result.content[0]?.text;
	expect(typeof text).toBe("string");
	if (typeof text !== "string")
		throw new Error("fetch result should contain text");
	expect(result.isError).not.toBe(true);
	if (result.isError === true) throw new Error(`fetch should succeed: ${text}`);
	return JSON.parse(text) as FetchJson;
}

function fixtureResponse(request: Request): Response {
	const url = new URL(request.url);
	if (url.pathname === "/robots.txt") {
		return text(`User-agent: *\nAllow: /\n`, "text/plain");
	}
	if (url.pathname === "/llms.txt") return text("not found", "text/plain", 404);
	if (url.pathname === "/sitemap.xml") {
		return text(
			`<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
	<url><loc>${origin}/guide/use-effect</loc></url>
	<url><loc>${origin}/guide/styling</loc></url>
</urlset>`,
			"application/xml",
		);
	}
	const body = pages[trimSlash(url.pathname)];
	if (!body) return text("not found", "text/plain", 404);
	pageHits++;
	return text(body, "text/html; charset=utf-8");
}

function page(title: string, body: string): string {
	return `<!doctype html><html><head><title>${title}</title></head><body><main><h1>${title}</h1>${body}</main></body></html>`;
}

function text(body: string, contentType: string, status = 200): Response {
	return new Response(body, {
		status,
		headers: { "content-type": contentType },
	});
}

function trimSlash(pathname: string): string {
	return pathname !== "/" ? pathname.replace(/\/+$/, "") : pathname;
}
