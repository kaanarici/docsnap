import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "../src/cli/args.ts";
import { dedupeRecords } from "../src/core/dedupe.ts";
import { type FetchedUrl, lowQualityConfidence } from "../src/core/types.ts";
import { discoverLlms } from "../src/discover/llms.ts";
import { discoverPageLinks } from "../src/discover/nav.ts";
import { parseRobots } from "../src/discover/robots.ts";
import { normalizeUrl, sameScopeLinks } from "../src/discover/url.ts";
import { extractPage } from "../src/extract/html.ts";
import { scoreMarkdown } from "../src/extract/quality.ts";
import { fetchText, setFetchTransportForTest } from "../src/fetch/fetcher.ts";
import { installAgentFiles } from "../src/output/agent-files.ts";
import { validatePublicHttpUrl } from "../src/security/url.ts";

const html = `
<!doctype html>
<html>
	<head>
		<title>Example Labs</title>
		<meta name="Description" content="A product lab building developer tools.">
	</head>
	<body>
		<template data-dgst="BAILOUT_TO_CLIENT_SIDE_RENDERING"></template>
		<script>
			self.__next_f.push(["static/chunks/app/page.js?dpl=abc", "dangerouslySetInnerHTML", "scroll-smooth __variable_c18e00"]);
		</script>
	</body>
</html>`;
const record = await extractPage({
	source: "seed",
	result: {
		ok: true,
		url: "https://example.com/",
		finalUrl: "https://example.com/",
		status: 200,
		contentType: "text/html; charset=utf-8",
		body: html,
		fetchMs: 1,
	},
} satisfies FetchedUrl);
assert(record.ok);
assert(record.markdown.includes("A product lab building developer tools."));
assert(!record.markdown.includes("static/chunks"));
assert(!record.markdown.includes("dangerouslySetInnerHTML"));
assert(!record.markdown.includes("__variable"));
assert(record.confidence < lowQualityConfidence);
assert(record.qualityReasons.includes("thin content"));
const bodylessRecord = await extractPage({
	source: "seed",
	result: {
		ok: true as const,
		url: "https://www.openssh.com/manual.html",
		finalUrl: "https://www.openssh.com/manual.html",
		status: 200,
		contentType: "text/html",
		body: `<!doctype html><html lang=en><meta charset=utf-8><title>OpenSSH: Manual Pages</title><h2>Manual Pages</h2><p>Web manual pages are available from OpenBSD for the following commands.</p><ul><li><a href="https://man.openbsd.org/ssh">ssh(1)</a> - The basic rlogin client program<li><a href="https://man.openbsd.org/sshd">sshd(8)</a> - The daemon that permits you to log in</ul></html>`,
		fetchMs: 1,
	},
} satisfies FetchedUrl);
assert(bodylessRecord.ok);
assert(bodylessRecord.markdown.includes("Web manual pages are available"));
const robots = parseRobots(
	"User-agent: docsnap\nDisallow: /private\n\nUser-agent: *\nAllow: /",
	"https://example.com",
	"Mozilla/5.0 (compatible; docsnap/0.1; +https://npmjs.com/package/docsnap)",
);
assert(!robots.allowed("https://example.com/private/page"));
assert(robots.allowed("https://example.com/public/page"));
const parsedPage = parseArgs(["https://docs.example.com/api/auth", "--page"]);
assert(!("help" in parsedPage) && !("version" in parsedPage));
assert(parsedPage.pageOnly);
assert(parsedPage.seedUrl === "https://docs.example.com/api/auth");
assert(validatePublicHttpUrl("http://169.254.169.254/latest/meta-data"));
assert(validatePublicHttpUrl("http://[::ffff:7f00:1]/private") !== undefined);
assert(validatePublicHttpUrl("http://[::7f00:1]/private") !== undefined);
assert(validatePublicHttpUrl("http://[fec0::1]/private") !== undefined);
assert(validatePublicHttpUrl("http://[ff02::1]/private") !== undefined);
assert(validatePublicHttpUrl("https://[2606:4700:4700::1111]/") === undefined);
const unsafeFetch = await fetchText("http://127.0.0.1:1/private", parsedPage);
assert(!unsafeFetch.ok && unsafeFetch.failureKind === "unsafe_url");
const badLlmsRoot = "https://docs.example.com/llms-full.txt";
await withMockFetch(
	async () => {
		const result = await fetchText("https://93.184.216.34/start", parsedPage);
		assert(!result.ok);
		assert(result.failureKind === "unsafe_url");
	},
	async () => Response.redirect("http://127.0.0.1/private", 302),
);
await withMockFetch(
	async () => {
		const result = await fetchText("https://93.184.216.34/start", parsedPage);
		assert(!result.ok);
		assert(result.failureKind === "unsafe_url");
	},
	async () =>
		new Response(
			`<meta http-equiv="refresh" content="0; url=http://127.0.0.1/private">`,
			{
				headers: { "content-type": "text/html" },
			},
		),
);
await withMockFetch(
	async () => {
		const result = await fetchText("https://93.184.216.34/docs", parsedPage);
		assert(result.ok);
		assert(result.finalUrl === "https://93.184.216.34/42/intro");
		assert(result.body === "# Versioned docs");
	},
	async (input) => {
		const url = String(input);
		if (url.endsWith("/42/intro"))
			return new Response("# Versioned docs", {
				headers: { "content-type": "text/markdown" },
			});
		const step = Number(url.match(/\/docs\/refresh-(\d)$/)?.[1] ?? 0);
		if (step > 0) {
			const target = step < 4 ? `/docs/refresh-${step + 1}` : "/docs/version";
			return htmlRefresh(target);
		}
		if (!url.endsWith("/docs/version")) return htmlRefresh("/docs/refresh-1");
		return new Response(
			`<script>var ignored, version = "42"; window.location = "/" + version + "/intro";</script><p>Redirecting...</p>`,
			{
				headers: { "content-type": "text/html" },
			},
		);
	},
);
await withMockFetch(
	async () => {
		const result = await fetchText("https://93.184.216.34/docs/", parsedPage);
		assert(result.ok);
		assert(result.finalUrl === "https://93.184.216.34/docs/welcome.html");
		assert(result.body.includes("__DOCSNAP_WRITERSIDE_TOPIC__"));
		const record = await extractPage({ source: "seed", result });
		assert(record.ok);
		assert(record.markdown.includes("Create a RESTful API"));
		assert(
			discoverPageLinks(result.body, result.finalUrl).includes(
				"https://93.184.216.34/docs/server-create-restful-apis.html",
			),
		);
	},
	async (input) => {
		const url = String(input);
		if (url.endsWith("/docs/starting-page-welcome.json")) {
			return new Response(
				JSON.stringify({
					title: "Ktor Documentation",
					subtitle:
						"Ktor builds asynchronous server-side and client-side applications with routing, plugins, authentication, and production deployment guides.",
					main: {
						title: "Ktor Server",
						data: [
							{
								title: "Create a RESTful API",
								description:
									"Learn how to build a RESTful API with Ktor, including setup, routing, and testing on a real-life example.",
								url: "server-create-restful-apis.html",
							},
						],
					},
				}),
				{ headers: { "content-type": "application/json" } },
			);
		}
		if (url.endsWith("/docs/welcome.html")) {
			return new Response(
				`<!doctype html><title>Welcome | Ktor Documentation</title><body data-topic="starting-page-welcome.json"><script src="https://resources.jetbrains.com/writerside/apidoc/app.js"></script></body>`,
				{ headers: { "content-type": "text/html" } },
			);
		}
		return new Response(
			`<meta http-equiv = "refresh" content="0; URL='welcome.html'">`,
			{ headers: { "content-type": "text/html" } },
		);
	},
);
let cookieSeen = false;
await withMockFetch(
	async () => {
		const result = await fetchText(
			"https://docs.example.com/start",
			parsedPage,
		);
		assert(result.ok && cookieSeen);
	},
	async (_input, init) => {
		const cookie = new Headers(init?.headers).get("cookie");
		if (cookie === "docsnap_challenge=ok" && String(_input).includes("docs.")) {
			cookieSeen = true;
			return new Response("# Ready", {
				headers: { "content-type": "text/markdown" },
			});
		}
		return new Response("redirect", {
			status: 302,
			headers: {
				location: "https://docs.example.com/start",
				"set-cookie":
					"docsnap_challenge=ok; Domain=.example.com; Path=/; Secure",
			},
		});
	},
);
await withMockFetch(
	async () => {
		const result = await fetchText("https://93.184.216.34/docs/topic.md", {
			...parsedPage,
			maxBytes: 1024,
		});
		assert(result.ok);
		assert(result.finalUrl === "https://93.184.216.34/docs/topic");
		assert(result.body === "<main>Recovered HTML docs route</main>");
		const rootResult = await fetchText(
			"https://93.184.216.34/guide.md",
			parsedPage,
		);
		assert(rootResult.ok && rootResult.finalUrl.endsWith("/docs/guide.md"));
	},
	async (input) => {
		const url = String(input);
		if (url.endsWith("/docs/guide.md")) return new Response("# Guide");
		if (
			url.endsWith("/docs/topic.md") ||
			url.endsWith("/guide.md") ||
			url.endsWith("/guide")
		) {
			return new Response("not found", { status: 404 });
		}
		return new Response("<main>Recovered HTML docs route</main>", {
			headers: { "content-type": "text/html" },
		});
	},
);
await withMockFetch(
	async () => {
		const result = await fetchText(
			"https://93.184.216.34/docs/frontmatter.md",
			parsedPage,
		);
		assert(result.ok);
		assert(result.finalUrl === "https://93.184.216.34/docs/frontmatter");
		assert(result.body === "<main>Recovered frontmatter stub</main>");
		const emptyResult = await fetchText(
			"https://93.184.216.34/docs/empty.md",
			parsedPage,
		);
		assert(emptyResult.ok && emptyResult.finalUrl.endsWith("/docs/empty"));
	},
	async (input) => {
		const url = String(input);
		if (url.endsWith("/docs/empty.md")) return new Response("");
		if (url.endsWith("/docs/empty"))
			return new Response("<main>Recovered empty markdown stub</main>");
		if (url.endsWith("/docs/frontmatter.md")) {
			return new Response("---\ntitle: Stub\n---", {
				headers: { "content-type": "text/markdown" },
			});
		}
		return new Response("<main>Recovered frontmatter stub</main>", {
			headers: { "content-type": "text/html" },
		});
	},
);
assert(
	normalizeUrl("https://example.com/openapi.json")?.endsWith("/openapi.json"),
);
for (const badUrl of [
	"https://example.com/blog/rss.xml",
	"https://example.com/docs/auth0%E2%80%A6",
	"https://example.com/search",
	...["genindex.html", "_sources/index.rst.txt", "COPYING_ja.html"].map(
		(path) => `https://example.com/docs/${path}`,
	),
	"https://example.com/++theme++2025/index.html",
	"https://example.com/create-account",
	"https://example.com/cgi-bin/browse-edgar",
	"https://example.com/.well-known/captcha/565/botdetect/",
	"https://example.com/auth/sign-in",
	"https://example.com/cdn-cgi/l/email-protection",
	"https://example.com/page/index.md",
	"https://example.com/index.html.md",
	"https://example.com/api/article",
	"https://example.com/en/Pages/youtube.com/watch",
	"https://example.com/llm/json/chunked/index.json",
])
	assert(normalizeUrl(badUrl) === undefined);
await withMockFetch(
	async () => {
		const urls = await discoverLlms("https://docs.example.com/docs", {
			...parsedPage,
			seedUrl: "https://docs.example.com/docs",
			max: 4,
			maxExplicit: true,
		});
		assert(urls.includes("https://docs.example.com/docs/vault/quick-start"));
		assert(!urls.some((url) => url.includes("/widgets/")));
		assert(!urls.includes(badLlmsRoot));
	},
	async () =>
		new Response(
			`# Docs
## Widgets
- [User Sessions Widget](https://docs.example.com/docs/widgets/user-sessions)
- [User Security Widget](https://docs.example.com/docs/widgets/user-security)
- [User Profile Widget](https://docs.example.com/docs/widgets/user-profile)
## Useful docs
- Full docs: https://docs.example.com/docs/llms-full.txt
- [Vault Quick Start](https://docs.example.com/docs/vault/quick-start)
- [SSO Launch Checklist](https://docs.example.com/docs/sso/launch-checklist)
- [API Reference](https://docs.example.com/docs/reference)`,
			{
				headers: { "content-type": "text/markdown" },
			},
		),
);
assert(
	scoreMarkdown(
		`Short helper docs with runnable setup and a complete example for agents using the package in automation scripts.\n\n\`\`\`ts\nimport { Helper } from "pkg";\nconst helper = new Helper({ strict: true });\nawait helper.run({ input: "docs" });\nconsole.log(helper.status);\n\`\`\``,
		"Helper",
	).confidence >= lowQualityConfidence,
);
assert(
	scoreMarkdown(
		`Documentation for this package. These links are the maintained entry points for installing, configuring, operating, and securing the package. Agents can use this page as a compact map before opening the task-specific references below.\n\n- [Install](https://example.com/install)\n- [Config](https://example.com/config)\n- [API](https://example.com/api)\n- [CLI](https://example.com/cli)\n- [Security](https://example.com/security)\n- [Examples](https://example.com/examples)`,
		"Docs",
	).confidence >= lowQualityConfidence,
);
assert(
	scoreMarkdown("Dashboard sign in links only", "Widget").confidence < 0.6,
);
const yamlRecord = await extractPage({
	source: "seed",
	result: {
		ok: true,
		url: "https://example.com/openapi.yaml",
		finalUrl: "https://example.com/openapi.yaml",
		status: 200,
		contentType: "text/yaml",
		body: "openapi: '3.0.3'\ninfo:\n  description: See <a href='https://example.com'>API docs</a>",
		fetchMs: 1,
	},
} satisfies FetchedUrl);
assert(yamlRecord.ok);
assert(yamlRecord.extractor === "text");
assert(yamlRecord.markdown.includes("```yaml"));
const serializedRecord = await extractPage({
	source: "seed",
	result: {
		ok: true,
		url: "https://docs.example.com/vault/quick-start",
		finalUrl: "https://docs.example.com/vault/quick-start",
		status: 200,
		contentType: "text/html",
		body: `<!doctype html><title>Quick Start</title><main><a href="/docs">Docs</a><a href="/reference">Reference</a><a href="/signin">Sign In</a></main><script id="__NEXT_DATA__" type="application/json">{"props":{"pageProps":{"content":[{"title":"Install the SDK","description":"Install the SDK and configure the client before making requests."},{"children":"Create an encrypted object, retrieve it later, update its value, and delete it when the data is no longer needed."},{"children":"Store API keys as managed secrets and pass them through environment variables in production."}]}}}</script>`,
		fetchMs: 1,
	},
} satisfies FetchedUrl);
assert(serializedRecord.ok);
assert(serializedRecord.extractor === "fallback");
assert(serializedRecord.confidence >= lowQualityConfidence);
assert(serializedRecord.markdown.includes("Create an encrypted object"));
const links = sameScopeLinks(
	"See https://docs.example.com/v2/sources. and /v2/fs/{source_id}/files. and /sitemap.xml and /robots.txt and https://developers.example.com/workers/scripts/:worker/_name. and https://developers.example.com/workers/examples/cors/%3C/span%3E.",
	"https://docs.example.com/llms.txt",
);
assert(links.includes("https://docs.example.com/v2/sources"));
assert(!links.some((link) => link.endsWith("/sitemap.xml")));
assert(!links.some((link) => link.includes("%7B")));
assert(!links.some((link) => link.includes(":worker")));
assert(
	sameScopeLinks(
		"[Intro](en/latest/index.md)",
		"https://docs.scrapy.org/en/latest/llms.txt",
	).includes("https://docs.scrapy.org/en/latest/index.md"),
);
const duplicate = dedupeRecords([
	page("https://docs.peel.sh/reference/exports", "html", "html body"),
	page(
		"https://docs.peel.sh/reference/exports.md",
		"markdown",
		"markdown body",
	),
]);
assert(duplicate.deduped === 1);
assert(duplicate.records.length === 1);
assert(
	duplicate.records[0]?.ok && duplicate.records[0].markdown === "markdown body",
);
const encodedDuplicate = dedupeRecords([
	page("https://docs.example.com/Web/API/Fetch_API/Using_Fetch", "html", "one"),
	page(
		"https://docs.example.com/Web/API/Fetch%5FAPI/Using%5FFetch",
		"html",
		"two",
	),
]);
assert(encodedDuplicate.deduped === 1);
assert(encodedDuplicate.records.length === 1);
const dir = await mkdtemp(join(tmpdir(), "docsnap-regression-"));
await writeFile(join(dir, "AGENTS.md"), "# Repo\n");
const files = await installAgentFiles(
	{
		status: "ok",
		seedUrl: "https://docs.example.com/",
		outDir: "docsnap/docs-example-com",
		dryRun: false,
		generatedAt: "2026-04-30T00:00:00.000Z",
		snapshotVersion: 1,
		rootHash: "hash",
		renderedFiles: 1,
		renderedBytes: 1,
		max: 50,
		maxAppliesTo: "non-llms",
		maxReached: false,
		discovered: 1,
		deduped: 0,
		written: 1,
		failed: 0,
		lowQuality: 0,
		elapsedMs: 1,
		pagesPerSecond: 1,
		bySource: {
			seed: 1,
			llms: 0,
			sitemap: 0,
			nav: 0,
			crawl: 0,
			asset: 0,
		},
		byFailureKind: {},
		errors: [],
	},
	dir,
);
const agentFile = await readFile(join(dir, "AGENTS.md"), "utf8");
assert(files.length === 1 && files[0] === "AGENTS.md");
assert(agentFile.includes("docsnap/docs-example-com/AGENT_README.md"));
function assert(condition: unknown): asserts condition {
	if (!condition) throw new Error("assertion failed");
}
function htmlRefresh(target: string) {
	return new Response(
		`<meta http-equiv="refresh" content="0; url=${target}">`,
		{
			headers: { "content-type": "text/html" },
		},
	);
}
async function withMockFetch(
	test: () => Promise<void>,
	mock: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
): Promise<void> {
	setFetchTransportForTest(async (input, headers) => {
		const unsafe = validatePublicHttpUrl(input);
		if (unsafe) throw new Error(unsafe);
		const response = await mock(input, { headers });
		return {
			url: input,
			status: response.status,
			headers: {
				get: (name) => response.headers.get(name),
				getSetCookie: () =>
					(
						response.headers as Headers & {
							getSetCookie?: () => string[];
						}
					).getSetCookie?.() ?? [response.headers.get("set-cookie") ?? ""],
			},
			body: new Uint8Array(await response.arrayBuffer()),
		};
	});
	try {
		await test();
	} finally {
		setFetchTransportForTest(undefined);
	}
}
function page(url: string, extractor: "html" | "markdown", markdown: string) {
	return {
		ok: true as const,
		url,
		finalUrl: url,
		status: 200,
		source: extractor === "markdown" ? ("llms" as const) : ("nav" as const),
		timings: { fetchMs: 1, extractMs: 1, writeMs: 0 },
		markdown,
		links: [],
		contentHash: markdown,
		extractor,
		confidence: 1,
		qualityReasons: [],
	};
}
