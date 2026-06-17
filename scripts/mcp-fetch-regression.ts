import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	exitOnSandboxNetworkDisabled,
	startLoopbackServer,
	type TestServer,
} from "./local-fixture.ts";
import { McpClient } from "./mcp-client.ts";

// Protects the docsnap_fetch drop-in WebFetch contract through the real stdio
// MCP server: one call captures a public URL into a persistent corpus and
// returns a ranked, fenced, cited context pack; freshness reuse skips the
// network; refresh re-runs the seed; scope page captures a single page; and
// output_dir containment plus robots safety are preserved. Runs on a hermetic
// loopback fixture, no external network.

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

exitOnSandboxNetworkDisabled("mcp-fetch-regression local server");

const fixtureText =
	"Hermetic docsnap_fetch fixture: the dependency array controls when an effect re-runs.";
let origin = "";
let pageHits = 0;
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

const tmpRoot = await mkdtemp(join(tmpdir(), "docsnap-fetch-"));
let fixture: TestServer | undefined;
let client: McpClient | undefined;

try {
	fixture = await startLoopbackServer(fixtureResponse);
	origin = fixture.origin;
	client = new McpClient(origin, tmpRoot);

	await client.request("initialize", {
		protocolVersion: "2025-06-18",
		capabilities: {},
		clientInfo: { name: "docsnap-fetch-regression", version: "0.0.0" },
	});
	client.notify("notifications/initialized", {});

	// 1. one call captures a small site and returns a ranked cited context pack
	const captured = await callFetch({
		url: `${origin}/`,
		question: "how do I run an effect only once on mount",
		max_pages: 5,
	});
	assert(captured.corpus?.action === "captured", "first fetch should capture");
	assert(captured.corpus?.scope === "site", "root URL should capture as site");
	assert((captured.corpus?.written ?? 0) >= 2, "should write multiple pages");
	assert(captured.question === "how do I run an effect only once on mount");
	assert((captured.citation_count ?? 0) > 0, "should return citations");
	const top = captured.citations?.[0];
	assert(
		top?.output_path?.includes("use-effect"),
		"effect page should rank first",
	);
	assert(
		typeof top?.citation_id === "string" && top.citation_id.includes("#L"),
		"citation should carry a line-anchored id",
	);
	assert(typeof top?.content_hash === "string" && top.content_hash.length > 0);
	assert(
		top?.snippet?.includes("WEB-DERIVED CONTENT (UNTRUSTED DATA)"),
		"snippet must be fenced as untrusted web data",
	);
	assert(
		top?.snippet?.includes("Source URL:"),
		"snippet must carry source provenance",
	);
	const outputDir = captured.corpus?.output_dir ?? "";
	assert(outputDir.length > 0, "fetch should report an output_dir");
	for (const file of ["summary.json", "manifest.jsonl", "AGENT_README.md"]) {
		await readFile(join(outputDir, file), "utf8");
	}

	// 2. freshness reuse: a second call to the same URL must not re-fetch the site
	const hitsAfterCapture = pageHits;
	const reused = await callFetch({
		url: `${origin}/`,
		question: "how do I clean up an effect",
		freshness: "reuse",
		max_pages: 5,
	});
	assert(
		reused.corpus?.action === "reused",
		"second fetch should reuse corpus",
	);
	assert(
		pageHits === hitsAfterCapture,
		"reuse must not re-fetch the origin over the network",
	);
	assert(
		(reused.citation_count ?? 0) > 0,
		"reuse should still answer with sources",
	);

	// 3. freshness refresh: re-runs the seed (network touched again)
	const refreshed = await callFetch({
		url: `${origin}/`,
		freshness: "refresh",
		max_pages: 5,
	});
	assert(
		refreshed.corpus?.action === "refreshed",
		"refresh should re-run the seed",
	);
	assert(pageHits > hitsAfterCapture, "refresh must touch the network again");
	// no question: returns navigation, not a context pack
	assert(
		refreshed.citation_count === undefined,
		"no question => no context pack",
	);
	assert(
		(refreshed.top_pages?.length ?? 0) > 0,
		"no-question fetch should list top pages",
	);
	assert(
		(refreshed.next_actions?.length ?? 0) > 0,
		"no-question fetch should suggest next actions",
	);

	// 4. scope page: a single page capture, distinct corpus, only one page written
	const single = await callFetch({
		url: `${origin}/guide/use-effect`,
		scope: "page",
		question: "what does the dependency array do",
	});
	assert(single.corpus?.scope === "page", "scope page should be reported");
	assert(
		single.corpus?.written === 1,
		"scope page should write exactly one page",
	);
	assert((single.citation_count ?? 0) > 0, "single page fetch should cite");

	// 5. output_dir containment: a path outside the server cwd is rejected
	const escaped = (await client.request("tools/call", {
		name: "docsnap_fetch",
		arguments: { url: `${origin}/`, output_dir: "../escape" },
	})) as ToolCallResult;
	assert(escaped.isError === true, "output_dir outside cwd must be rejected");
	assert(
		(escaped.content[0]?.text ?? "").includes("under the MCP server cwd"),
		"escape error should explain the cwd boundary",
	);

	// 6. robots safety preserved: localhost is refused like every other tool
	const unsafe = (await client.request("tools/call", {
		name: "docsnap_fetch",
		arguments: { url: "http://localhost:1234" },
	})) as ToolCallResult;
	assert(unsafe.isError === true, "unsafe URL should be a tool error");
	assert(
		(unsafe.content[0]?.text ?? "").includes("localhost URLs are not allowed"),
		"unsafe URL error should name the boundary",
	);

	console.log("mcp-fetch-regression: ok");
} finally {
	await client?.stop();
	await fixture?.stop();
	await rm(tmpRoot, { recursive: true, force: true });
}

async function callFetch(args: Record<string, unknown>): Promise<FetchJson> {
	const result = (await client?.request("tools/call", {
		name: "docsnap_fetch",
		arguments: args,
	})) as ToolCallResult;
	const text = result.content[0]?.text;
	assert(typeof text === "string", "fetch result should contain text");
	assert(result.isError !== true, `fetch should succeed: ${text}`);
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

function assert(
	condition: unknown,
	message = "assertion failed",
): asserts condition {
	if (!condition) throw new Error(message);
}
