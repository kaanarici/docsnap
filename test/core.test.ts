import { describe, expect, test } from "bun:test";
import { buildPipelineConfig, parseArgs } from "../src/cli/args.ts";
import { type FetchedUrl, lowQualityConfidence } from "../src/core/types.ts";
import { discoverLlms } from "../src/discover/llms.ts";
import { discoverPageLinks } from "../src/discover/nav.ts";
import { normalizeUrl, sameScopeLinks } from "../src/discover/url.ts";
import { extractPage } from "../src/extract/html.ts";
import { scoreMarkdown } from "../src/extract/quality.ts";
import { fetchText, setFetchTransportForTest } from "../src/fetch/fetcher.ts";
import { validatePublicHttpUrl } from "../src/security/url.ts";

const parsedPageArgs = parseArgs([
	"https://docs.example.com/api/auth",
	"--page",
]);
if ("help" in parsedPageArgs || "version" in parsedPageArgs) {
	throw new Error("parseArgs returned help/version");
}
const parsedPage = buildPipelineConfig(parsedPageArgs.run);

const badLlmsRoot = "https://docs.example.com/llms-full.txt";
const writersideTopic =
	'{"title":"Ktor Documentation","subtitle":"Ktor builds asynchronous server-side and client-side applications with routing, plugins, authentication, and production deployment guides.","main":{"title":"Ktor Server","data":[{"title":"Create a RESTful API","description":"Learn how to build a RESTful API with Ktor, including setup, routing, and testing on a real-life example.","url":"server-create-restful-apis.html"}]}}';
const llmsText =
	"# Docs\n## Widgets\n- [User Sessions Widget](https://docs.example.com/docs/widgets/user-sessions)\n- [User Security Widget](https://docs.example.com/docs/widgets/user-security)\n- [User Profile Widget](https://docs.example.com/docs/widgets/user-profile)\n## Useful docs\n- Full docs: https://docs.example.com/docs/llms-full.txt\n- [Vault Quick Start](https://docs.example.com/docs/vault/quick-start)\n- [SSO Launch Checklist](https://docs.example.com/docs/sso/launch-checklist)\n- [API Reference](https://docs.example.com/docs/reference)";
type Ok<T> = Extract<T, { ok: true }>;
type NotOk<T> = Extract<T, { ok: false }>;

describe("extraction core behavior", () => {
	test("client-rendered bailout page fails honestly as empty", async () => {
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
		const record = await extractPage(
			fetched("https://example.com/", "text/html; charset=utf-8", html),
		);
		const failed = expectNotOk(record);
		expect(failed.failureKind).toBe("empty");
	});

	test("bodyless HTML with meaningful prose is captured", async () => {
		const record = expectOk(
			await extractPage(
				fetched(
					"https://www.openssh.com/manual.html",
					"text/html",
					`<!doctype html><html lang=en><meta charset=utf-8><title>OpenSSH: Manual Pages</title><h2>Manual Pages</h2><p>Web manual pages are available from OpenBSD for the following commands.</p><ul><li><a href="https://man.openbsd.org/ssh">ssh(1)</a> - The basic rlogin client program<li><a href="https://man.openbsd.org/sshd">sshd(8)</a> - The daemon that permits you to log in</ul></html>`,
				),
			),
		);
		expect(record.markdown).toContain("Web manual pages are available");
	});

	test("YAML is extracted as fenced text", async () => {
		const record = expectOk(
			await extractPage(
				fetched(
					"https://example.com/openapi.yaml",
					"text/yaml",
					"openapi: '3.0.3'\ninfo:\n  description: See <a href='https://example.com'>API docs</a>",
				),
			),
		);
		expect(record.extractor).toBe("text");
		expect(record.markdown).toContain("```yaml");
	});

	test("serialized inline state recovers fallback content", async () => {
		const record = expectOk(
			await extractPage(
				fetched(
					"https://docs.example.com/vault/quick-start",
					"text/html",
					`<!doctype html><title>Quick Start</title><main><a href="/docs">Docs</a><a href="/reference">Reference</a><a href="/signin">Sign In</a></main><script id="__NEXT_DATA__" type="application/json">{"props":{"pageProps":{"content":[{"title":"Install the SDK","description":"Install the SDK and configure the client before making requests."},{"children":"Create an encrypted object, retrieve it later, update its value, and delete it when the data is no longer needed."},{"children":"Store API keys as managed secrets and pass them through environment variables in production."}]}}}</script>`,
				),
			),
		);
		expect(record.extractor).toBe("fallback");
		expect(record.confidence).toBeGreaterThanOrEqual(lowQualityConfidence);
		expect(record.markdown).toContain("Create an encrypted object");
	});
});

describe("CLI parsing and fetch safety", () => {
	test("page-only mode keeps seed URL", () => {
		expect(parsedPage.pageOnly).toBeTruthy();
		expect(parsedPage.seedUrl).toBe("https://docs.example.com/api/auth");
	});

	test("localhost fetch is rejected as unsafe", async () => {
		const result = expectNotOk(
			await fetchText("http://127.0.0.1:1/private", parsedPage),
		);
		expect(result.failureKind).toBe("unsafe_url");
	});
});

describe("fetch redirects and route recovery", () => {
	test.each([
		[
			"HTTP redirect",
			async () => Response.redirect("http://127.0.0.1/private", 302),
		],
		[
			"HTML refresh",
			async () =>
				typedResponse(
					`<meta http-equiv="refresh" content="0; url=http://127.0.0.1/private">`,
				),
		],
	])("%s to private network is rejected", async (_label, mock) => {
		await withMockFetch(async () => {
			const result = expectNotOk(
				await fetchText("https://93.184.216.34/start", parsedPage),
			);
			expect(result.failureKind).toBe("unsafe_url");
			expect(result.redirects?.[0]?.to).toBe("http://127.0.0.1/private");
		}, mock);
	});

	test("credential redirect strips credentials from serialized result", async () => {
		await withMockFetch(
			async () => {
				const result = expectNotOk(
					await fetchText(
						"https://93.184.216.34/credential-redirect",
						parsedPage,
					),
				);
				expect(result.failureKind).toBe("unsafe_url");
				expect(result.finalUrl).toBe("https://target.example/secret");
				expect(result.redirects?.[0]?.to).toBe("https://target.example/secret");
				expect(JSON.stringify(result)).not.toContain("user:pass");
			},
			async () =>
				new Response("", {
					status: 302,
					headers: {
						location: "https://user:pass@target.example/secret#token",
					},
				}),
		);
	});

	test("non-HTTP redirect is rejected without redirect entries", async () => {
		await withMockFetch(
			async () => {
				const result = expectNotOk(
					await fetchText(
						"https://93.184.216.34/non-http-redirect",
						parsedPage,
					),
				);
				expect(result.redirects?.length).toBe(0);
			},
			async () =>
				new Response("", {
					status: 302,
					headers: { location: "javascript:alert(1)" },
				}),
		);
	});

	test("chained HTML refresh can recover versioned docs route", async () => {
		await withMockFetch(
			async () => {
				const result = expectOk(
					await fetchText("https://93.184.216.34/docs", parsedPage),
				);
				expect(result.finalUrl).toBe("https://93.184.216.34/42/intro");
				expect(result.body).toBe("# Versioned docs");
			},
			async (input) => {
				const url = String(input);
				if (url.endsWith("/42/intro"))
					return typedResponse("# Versioned docs", "text/markdown");
				const step = Number(url.match(/\/docs\/refresh-(\d)$/)?.[1] ?? 0);
				if (step > 0) {
					const target =
						step < 4 ? `/docs/refresh-${step + 1}` : "/docs/version";
					return htmlRefresh(target);
				}
				if (!url.endsWith("/docs/version"))
					return htmlRefresh("/docs/refresh-1");
				return typedResponse(
					`<script>var ignored, version = "42"; window.location = "/" + version + "/intro";</script><p>Redirecting...</p>`,
				);
			},
		);
	});

	test("Writerside JSON topic is recovered and discoverable", async () => {
		await withMockFetch(
			async () => {
				const result = expectOk(
					await fetchText("https://93.184.216.34/docs/", parsedPage),
				);
				expect(result.finalUrl).toBe("https://93.184.216.34/docs/welcome.html");
				expect(result.body).toContain("__DOCSNAP_WRITERSIDE_TOPIC__");
				const record = expectOk(await extractPage({ source: "seed", result }));
				expect(record.markdown).toContain("Create a RESTful API");
				expect(discoverPageLinks(result.body, result.finalUrl)).toContain(
					"https://93.184.216.34/docs/server-create-restful-apis.html",
				);
			},
			async (input) => {
				const url = String(input);
				if (url.endsWith("/docs/starting-page-welcome.json")) {
					return typedResponse(writersideTopic, "application/json");
				}
				if (url.endsWith("/docs/welcome.html")) {
					return typedResponse(
						`<!doctype html><title>Welcome | Ktor Documentation</title><body data-topic="starting-page-welcome.json"><script src="https://resources.jetbrains.com/writerside/apidoc/app.js"></script></body>`,
					);
				}
				return typedResponse(
					`<meta http-equiv = "refresh" content="0; URL='welcome.html'">`,
				);
			},
		);
	});

	test("redirect cookie challenge is replayed for docs subdomain", async () => {
		let cookieSeen = false;
		await withMockFetch(
			async () => {
				expectOk(await fetchText("https://docs.example.com/start", parsedPage));
				expect(cookieSeen).toBe(true);
			},
			async (input, init) => {
				const cookie = new Headers(init?.headers).get("cookie");
				if (
					cookie === "docsnap_challenge=ok" &&
					String(input).includes("docs.")
				) {
					cookieSeen = true;
					return typedResponse("# Ready", "text/markdown");
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
	});

	test("markdown route fallback recovers HTML route and root docs path", async () => {
		await withMockFetch(
			async () => {
				const result = expectOk(
					await fetchText("https://93.184.216.34/docs/topic.md", {
						...parsedPage,
						maxBytes: 1024,
					}),
				);
				expect(result.finalUrl).toBe("https://93.184.216.34/docs/topic");
				expect(result.body).toBe("<main>Recovered HTML docs route</main>");
				const rootResult = expectOk(
					await fetchText("https://93.184.216.34/guide.md", parsedPage),
				);
				expect(rootResult.finalUrl.endsWith("/docs/guide.md")).toBe(true);
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
				return typedResponse("<main>Recovered HTML docs route</main>");
			},
		);
	});

	test("frontmatter-only markdown fallback recovers HTML route", async () => {
		await withMockFetch(
			async () => {
				const result = expectOk(
					await fetchText(
						"https://93.184.216.34/docs/frontmatter.md",
						parsedPage,
					),
				);
				expect(result.finalUrl).toBe("https://93.184.216.34/docs/frontmatter");
				expect(result.body).toBe("<main>Recovered frontmatter stub</main>");
				const emptyResult = expectOk(
					await fetchText("https://93.184.216.34/docs/empty.md", parsedPage),
				);
				expect(emptyResult.finalUrl.endsWith("/docs/empty")).toBe(true);
			},
			async (input) => {
				const url = String(input);
				if (url.endsWith("/docs/empty.md")) return new Response("");
				if (url.endsWith("/docs/empty"))
					return new Response("<main>Recovered empty markdown stub</main>");
				if (url.endsWith("/docs/frontmatter.md")) {
					return typedResponse("---\ntitle: Stub\n---", "text/markdown");
				}
				return typedResponse("<main>Recovered frontmatter stub</main>");
			},
		);
	});
});

describe("URL discovery filters", () => {
	test("openapi JSON URL is normalizable", () => {
		expect(
			normalizeUrl("https://example.com/openapi.json")?.endsWith(
				"/openapi.json",
			),
		).toBe(true);
	});

	test.each([
		"https://example.com/blog/rss.xml",
		"https://example.com/docs/auth0%E2%80%A6",
		"https://example.com/search",
		"https://example.com/docs/genindex.html",
		"https://example.com/docs/_sources/index.rst.txt",
		"https://example.com/docs/COPYING_ja.html",
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
	])("rejects non-doc URL: %s", (badUrl) => {
		expect(normalizeUrl(badUrl)).toBeUndefined();
	});

	test("same-scope link mining filters sitemap, templates, and encoded tags", () => {
		const links = sameScopeLinks(
			"See https://docs.example.com/v2/sources. and /v2/fs/{source_id}/files. and /sitemap.xml and /robots.txt and https://developers.example.com/workers/scripts/:worker/_name. and https://developers.example.com/workers/examples/cors/%3C/span%3E.",
			"https://docs.example.com/llms.txt",
		);
		expect(links).toContain("https://docs.example.com/v2/sources");
		expect(links.some((link) => link.endsWith("/sitemap.xml"))).toBe(false);
		expect(links.some((link) => link.includes("%7B"))).toBe(false);
		expect(links.some((link) => link.includes(":worker"))).toBe(false);
		expect(
			sameScopeLinks(
				"[Intro](en/latest/index.md)",
				"https://docs.scrapy.org/en/latest/llms.txt",
			),
		).toContain("https://docs.scrapy.org/en/latest/index.md");
	});

	test("llms discovery keeps useful docs and drops widget cluster", async () => {
		await withMockFetch(
			async () => {
				const urls = await discoverLlms("https://docs.example.com/docs", {
					...parsedPage,
					seedUrl: "https://docs.example.com/docs",
					max: 4,
					maxExplicit: true,
				});
				expect(urls).toContain(
					"https://docs.example.com/docs/vault/quick-start",
				);
				expect(urls.some((url) => url.includes("/widgets/"))).toBe(false);
				expect(urls).not.toContain(badLlmsRoot);
			},
			async () => typedResponse(llmsText, "text/markdown"),
		);
	});
});

describe("quality scoring", () => {
	test.each([
		[
			"concise runnable helper docs",
			`Short helper docs with runnable setup and a complete example for agents using the package in automation scripts.\n\n\`\`\`ts\nimport { Helper } from "pkg";\nconst helper = new Helper({ strict: true });\nawait helper.run({ input: "docs" });\nconsole.log(helper.status);\n\`\`\``,
			"Helper",
		],
		[
			"compact docs map",
			`Documentation for this package. These links are the maintained entry points for installing, configuring, operating, and securing the package. Agents can use this page as a compact map before opening the task-specific references below.\n\n- [Install](https://example.com/install)\n- [Config](https://example.com/config)\n- [API](https://example.com/api)\n- [CLI](https://example.com/cli)\n- [Security](https://example.com/security)\n- [Examples](https://example.com/examples)`,
			"Docs",
		],
	])("%s meets quality threshold", (_label, markdown, title) => {
		expect(scoreMarkdown(markdown, title).confidence).toBeGreaterThanOrEqual(
			lowQualityConfidence,
		);
	});

	test("sign-in-only dashboard copy stays low confidence", () => {
		expect(
			scoreMarkdown("Dashboard sign in links only", "Widget").confidence,
		).toBeLessThan(0.6);
	});
});

function expectOk<T extends { ok: boolean }>(record: T): Ok<T> {
	expect(record.ok).toBe(true);
	if (!record.ok) throw new Error("expected ok record");
	return record as Ok<T>;
}

function expectNotOk<T extends { ok: boolean }>(record: T): NotOk<T> {
	expect(record.ok).toBe(false);
	if (record.ok) throw new Error("expected failed record");
	return record as NotOk<T>;
}

function fetched(url: string, contentType: string, body: string): FetchedUrl {
	const result = {
		ok: true,
		url,
		finalUrl: url,
		status: 200,
		contentType,
		body,
		fetchMs: 1,
	} as const;
	return {
		source: "seed",
		result,
	};
}

function htmlRefresh(target: string) {
	return typedResponse(
		`<meta http-equiv="refresh" content="0; url=${target}">`,
	);
}

function typedResponse(body: BodyInit, contentType = "text/html") {
	return new Response(body, { headers: { "content-type": contentType } });
}

async function withMockFetch(
	test: () => Promise<void>,
	mock: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
): Promise<void> {
	setFetchTransportForTest(async (input, headers) => {
		const unsafe = validatePublicHttpUrl(input);
		if (unsafe) throw new Error(unsafe);
		const response = await mock(input, { headers });
		const responseHeaders = response.headers as Headers & {
			getSetCookie?: () => string[];
		};
		const getSetCookie = () =>
			responseHeaders.getSetCookie?.() ?? [
				response.headers.get("set-cookie") ?? "",
			];
		return {
			url: input,
			status: response.status,
			headers: {
				get: (name) => response.headers.get(name),
				getSetCookie,
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
