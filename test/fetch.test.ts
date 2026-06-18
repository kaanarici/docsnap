import { afterEach, describe, expect, test } from "bun:test";
import { createServer } from "node:http";
import { html, httpResponse, typed } from "../scripts/fetch-fixtures.ts";
import { sandboxNetworkDisabled } from "../scripts/local-fixture.ts";
import { buildPipelineConfig, parseArgs } from "../src/cli/args.ts";
import type { PipelineConfig } from "../src/core/types.ts";
import { discoverAssetPages } from "../src/discover/assets.ts";
import { discover } from "../src/discover/index.ts";
import { discoverSitemaps } from "../src/discover/sitemap.ts";
import { fetchText, setFetchTransportForTest } from "../src/fetch/fetcher.ts";
import {
	requestPublicHttp,
	setResolvePublicHttpUrlForTest,
} from "../src/fetch/transport.ts";
import { validatePublicHttpUrl } from "../src/security/url.ts";

type FetchTextResult = Awaited<ReturnType<typeof fetchText>>;
type FetchTextOk = Extract<FetchTextResult, { ok: true }>;
type FetchTextFailed = Extract<FetchTextResult, { ok: false }>;
const config = configFrom(["https://docs.example.com", "--page"]);
const discoverConfig = configFrom(["https://docs.example.com/"]);
const loopbackFallbackAddresses = [
	{ address: "127.0.0.2", family: 4 },
	{ address: "127.0.0.3", family: 4 },
	{ address: "127.0.0.1", family: 4 },
] satisfies Array<{ address: string; family: 4 }>;
afterEach(() => {
	setFetchTransportForTest(undefined);
	setResolvePublicHttpUrlForTest(undefined);
});
describe("fetch configuration", () => {
	test("page mode keeps the default max bytes", () => {
		expect(config.maxBytes).toBe(12 * 1024 * 1024);
	});
});
describe.skipIf(sandboxNetworkDisabled())("public HTTP transport", () => {
	test("falls back to the second public address", async () => {
		await withServer(
			createServer((_req, res) => {
				res.writeHead(200, { "content-type": "text/plain" });
				res.end("second address");
			}),
			async (port) => {
				const raw = `http://multi.test:${port}/`;
				useMultiTestResolver(raw);
				const response = await requestPublicHttp(
					raw,
					{ accept: "text/plain", "user-agent": config.userAgent },
					{ ...config, timeoutMs: 500 },
				);
				expect(response.status).toBe(200);
				expect(new TextDecoder().decode(response.body)).toBe("second address");
			},
		);
	});
	test("enforces a deadline while a response trickles", async () => {
		await withServer(
			createServer((_req, res) => {
				res.writeHead(200, { "content-type": "text/plain" });
				let writes = 0;
				const timer = setInterval(() => {
					res.write("x");
					if (++writes >= 60) {
						clearInterval(timer);
						res.end();
					}
				}, 50);
				res.on("close", () => clearInterval(timer));
			}),
			async (port) => {
				const raw = `http://multi.test:${port}/`;
				useMultiTestResolver(raw);
				const started = performance.now();
				let failure = "";
				try {
					await requestPublicHttp(
						raw,
						{ accept: "text/plain", "user-agent": config.userAgent },
						{ ...config, timeoutMs: 200 },
					);
				} catch (error) {
					failure = error instanceof Error ? error.message : String(error);
				}
				expect(failure).toMatch(/deadline exceeded/);
				expect(performance.now() - started).toBeLessThan(2_000);
			},
		);
	});
});
describe("conditional fetches", () => {
	test("sends entity validators from cache metadata", async () => {
		const conditionalHeadersSeen: Record<string, string>[] = [];
		await assertFetch(
			"https://docs.example.com/cache",
			(result) => {
				expectOk(result);
				expect(conditionalHeadersSeen[0]?.["if-none-match"]).toBe('"v1"');
				expect(conditionalHeadersSeen[0]?.["if-modified-since"]).toBe(
					"Tue, 01 Jan 2024 00:00:00 GMT",
				);
			},
			async (_input, headers) => {
				conditionalHeadersSeen.push(headers);
				return html("Cached page");
			},
			{
				etag: '"v1"',
				lastModified: "Tue, 01 Jan 2024 00:00:00 GMT",
				urls: ["https://docs.example.com/cache"],
			},
		);
	});
	test("records not-modified cache metadata", async () => {
		await assertFetch(
			"https://docs.example.com/not-modified",
			(result) => {
				const ok = expectOk(result);
				expect(ok.notModified).toBe(true);
				expect(ok.status).toBe(304);
				expect(ok.body).toBe("");
				expect(ok.etag).toBe('"v2"');
				expect(Boolean(ok.fetchedAt)).toBe(true);
			},
			async () =>
				new Response(null, {
					status: 304,
					headers: {
						etag: '"v2"',
						"last-modified": "Wed, 02 Jan 2024 00:00:00 GMT",
					},
				}),
			{ etag: '"v1"', urls: ["https://docs.example.com/not-modified"] },
		);
	});
	test("does not forward validators to cross-host redirect targets", async () => {
		const redirectHeaders: Array<{
			url: string;
			headers: Record<string, string>;
		}> = [];
		const start = "https://docs.example.com/start";
		const start304 = "https://docs.example.com/start-304";
		const cond = (url: string) => ({ etag: '"start"', urls: [url] });
		await withMockFetch(
			async () => {
				const ok = expectOk(
					await fetchText(start, config, undefined, cond(start)),
				);
				expect(ok.finalUrl).toBe("https://other.example/ok");
				expect(redirectHeaders[0]?.headers["if-none-match"]).toBe('"start"');
				// no validator is sent to the cross-host target, so its bogus 304 must fail
				expect("if-none-match" in (redirectHeaders[1]?.headers ?? {})).toBe(
					false,
				);
				const bogus = expectFailed(
					await fetchText(start304, config, undefined, cond(start304)),
				);
				expect(bogus.status).toBe(304);
				expect(!("notModified" in bogus) || bogus.notModified !== true).toBe(
					true,
				);
			},
			async (input, headers) => {
				redirectHeaders.push({ url: input, headers });
				if (input === start) {
					return Response.redirect("https://other.example/ok", 302);
				}
				if (input === start304) {
					return Response.redirect("https://other.example/bogus", 302);
				}
				return input === "https://other.example/bogus"
					? new Response(null, { status: 304, headers: { etag: '"target"' } })
					: html("Redirect target");
			},
		);
	});
});
describe("fetch failures and recoveries", () => {
	test("blocks client challenge responses", async () => {
		await assertFetch(
			"https://93.184.216.34/challenge",
			expectFailure("blocked", "blocked by client challenge"),
			async () =>
				new Response("", {
					status: 202,
					headers: { "x-amzn-waf-action": "challenge" },
				}),
		);
	});
	test("recovers extensionless HTML routes", async () => {
		await assertFetch(
			"https://93.184.216.34/quickstart.html",
			expectFinalUrlAndBody(
				"https://93.184.216.34/quickstart",
				"<main>Recovered HTML route</main>",
			),
			async (input) =>
				input.endsWith(".html")
					? new Response("missing", { status: 404 })
					: html("<main>Recovered HTML route</main>"),
		);
	});
	test("keeps noscript refresh metadata as page content", async () => {
		await assertFetch(
			"https://93.184.216.34/meta",
			expectFinalUrl("https://93.184.216.34/meta"),
			async () =>
				html(
					`<noscript><meta http-equiv="refresh" content="0; URL=/fallback"></noscript><main>Readable docs page</main>`,
				),
		);
	});
	test("follows JavaScript location replacement", async () => {
		await assertFetch(
			"https://93.184.216.34/",
			expectFinalUrlAndBody(
				"https://93.184.216.34/latest/",
				"<main>Current docs</main>",
			),
			async (input) =>
				input.endsWith("/latest/")
					? html("<main>Current docs</main>")
					: html(
							`<title>Redirecting</title><script>window.location.replace("latest/" + window.location.search + window.location.hash);</script>`,
						),
		);
	});
	test("follows JavaScript assignment to markdown target", async () => {
		await assertFetch(
			"https://93.184.216.34/learn",
			expectFinalUrl("https://93.184.216.34/learn/intro/"),
			async (input) =>
				input.endsWith("/intro/")
					? typed("# Intro", "text/markdown")
					: html(
							`<p>If you are not redirected automatically please click here.</p><script>window.location = "/learn/intro/";</script>`,
						),
		);
	});
	test("records refused connections as fetch failures without retrying", async () => {
		let refusedAttempts = 0;
		await assertFetch(
			"https://93.184.216.34/refused",
			(result) => {
				expectFailure("fetch")(result);
				expect(refusedAttempts).toBe(1);
			},
			async () => {
				refusedAttempts++;
				throw new Error("connect ECONNREFUSED 93.184.216.34:443");
			},
		);
	});
	test("rejects unsafe local URLs before transport", async () => {
		let unsafeAttempts = 0;
		await assertFetch(
			"http://127.0.0.1/private",
			(result) => {
				expectFailure("unsafe_url")(result);
				expect(unsafeAttempts).toBe(0);
			},
			async () => {
				unsafeAttempts++;
				return new Response("unreachable");
			},
		);
	});
	test("rejects redirects to unsupported schemes", async () => {
		let unsupportedSchemeCalls = 0;
		await assertFetch(
			"https://docs.example.com/ftp",
			(result) => {
				expectFailure("unsafe_url")(result);
				expect(unsupportedSchemeCalls).toBe(1);
			},
			async (_input) => {
				unsupportedSchemeCalls++;
				return new Response("", {
					status: 301,
					headers: { location: "ftp://example.com/x" },
				});
			},
		);
	});
});
describe("redirect metadata", () => {
	test.each([
		[
			"public suffix cookie is not forwarded",
			"https://a.co.uk/start",
			"https://b.co.uk/end",
			"sid=bad; Domain=co.uk; Path=/",
			undefined,
		],
		[
			"registrable domain cookie is forwarded",
			"https://docs.example.co.uk/start",
			"https://www.example.co.uk/end",
			"sid=good; Domain=example.co.uk; Path=/",
			"sid=good",
		],
	])("%s", async (_label, start, target, setCookie, expectCookie) => {
		await assertRedirectCookie(start, target, setCookie, expectCookie);
	});
	test.each([
		[
			"records HTTP redirect hops",
			"to",
			"https://target.example/prompt",
			async (input: string) =>
				input === "https://target.example/prompt"
					? html("Redirect target")
					: Response.redirect("https://target.example/prompt", 302),
		],
		[
			"records refresh redirect hops",
			"type",
			"refresh",
			async (input: string) =>
				input === "https://target.example/prompt"
					? html("Redirect target")
					: html(
							`<meta http-equiv="refresh" content="0; url=https://target.example/prompt">`,
						),
		],
	])("%s", async (_label, field, expected, mock) => {
		await assertFetch(
			"https://docs.example.com/start",
			(result) => {
				const ok = expectOk(result);
				const hop = ok.redirects?.[0] as Record<string, unknown> | undefined;
				expect(ok.finalUrl).toBe("https://target.example/prompt");
				expect(hop?.[field]).toBe(expected);
			},
			mock,
		);
	});
});
describe("asset discovery", () => {
	test("uses base href for relative scripts without crossing scope", async () => {
		const assetFetches: string[] = [];
		setFetchTransportForTest(async (input) => {
			const url = String(input);
			assetFetches.push(url);
			return httpResponse(
				url,
				200,
				`path:"/docs",loadChildren:()=>import("https://cdn.example.net/chunk.js")`,
				"application/javascript",
			);
		});
		const pages = await discoverAssetPages(
			"https://docs.example.com/",
			`<html><head><base href="https://cdn.example.net/"></head><body><div id="app"></div><script src="main.js"></script></body></html>`,
			config,
			{ limit: 5, scope: "/", accept: () => true },
		);
		expect(pages).toHaveLength(0);
		expect(assetFetches).toContain("https://cdn.example.net/main.js");
		expect(assetFetches).not.toContain("https://docs.example.com/main.js");
	});
	test("does not fetch explicit cross-origin asset graphs", async () => {
		const explicitAssetFetches: string[] = [];
		setFetchTransportForTest(async (input) => {
			const url = String(input);
			explicitAssetFetches.push(url);
			return httpResponse(
				url,
				200,
				url.endsWith("/main.js")
					? `import("chunk.js")`
					: "console.log('chunk')",
				"application/javascript",
			);
		});
		const pages = await discoverAssetPages(
			"https://docs.example.com/",
			`<html><body><div id="app"></div><script src="https://cdn.example.net/main.js"></script></body></html>`,
			config,
			{ limit: 5, scope: "/", accept: () => true },
		);
		expect(pages).toHaveLength(0);
		expect(explicitAssetFetches).not.toContain(
			"https://cdn.example.net/main.js",
		);
		expect(explicitAssetFetches).not.toContain(
			"https://cdn.example.net/chunk.js",
		);
	});
});
describe("discovery boundaries", () => {
	test("ignores cross-origin nested sitemaps", async () => {
		const sitemapFetches: string[] = [];
		await withMockFetch(
			async () => {
				const urls = await discoverSitemaps(
					"https://docs.example.com/docs/",
					["https://evil.example/sitemap.xml"],
					config,
					{ limit: 2, scope: "/docs/", accept: () => true },
				);
				expect(urls).toContain("https://docs.example.com/docs/intro");
				expect(sitemapFetches).not.toContain(
					"https://evil.example/sitemap.xml",
				);
			},
			async (input) => {
				sitemapFetches.push(input);
				if (input === "https://docs.example.com/sitemap.xml") {
					return typed(
						`<sitemapindex>
						<sitemap><loc>https://evil.example/sitemap.xml</loc></sitemap>
						<sitemap><loc>https://docs.example.com/docs/sitemap.xml</loc></sitemap>
					</sitemapindex>`,
						"application/xml",
					);
				}
				if (input === "https://docs.example.com/docs/sitemap.xml") {
					return typed(
						`<urlset><url><loc>https://docs.example.com/docs/intro</loc></url></urlset>`,
						"application/xml",
					);
				}
				return new Response("not found", { status: 404 });
			},
		);
	});
	test("ignores redirects from default sitemap to another host", async () => {
		await withMockFetch(
			async () => {
				const urls = await discoverSitemaps(
					"https://docs.example.com/docs/",
					[],
					config,
					{ limit: 2, scope: "/docs/", accept: () => true },
				);
				expect(urls).toHaveLength(0);
			},
			async (input) =>
				input === "https://docs.example.com/sitemap.xml"
					? Response.redirect("https://evil.example/sitemap.xml", 302)
					: input === "https://evil.example/sitemap.xml"
						? typed(
								`<urlset><url><loc>https://docs.example.com/docs/intro</loc></url></urlset>`,
								"application/xml",
							)
						: new Response("not found", { status: 404 }),
		);
	});
	test("does not accept off-origin llms links", async () => {
		await withMockFetch(
			async () => {
				const urls = await discover(discoverConfig);
				expect(
					urls.some((item) => item.url.startsWith("https://evil.example/")),
				).toBe(false);
			},
			async (input) =>
				input === "https://docs.example.com/llms.txt"
					? typed(
							Array.from(
								{ length: 5 },
								(_, index) =>
									`- [Page ${index}](https://evil.example/${index}.md)`,
							).join("\n"),
							"text/plain",
						)
					: input === "https://docs.example.com/"
						? html("<main>Seed docs</main>")
						: new Response("not found", { status: 404 }),
		);
	});
});
function configFrom(args: string[]): PipelineConfig {
	const parsed = parseArgs(args);
	if ("help" in parsed || "version" in parsed) {
		throw new Error("parseArgs returned help/version");
	}
	return buildPipelineConfig(parsed.run);
}
function expectOk(record: FetchTextResult): FetchTextOk {
	expect(record.ok).toBe(true);
	if (!record.ok) throw new Error(record.error);
	return record;
}
function expectFailed(record: FetchTextResult): FetchTextFailed {
	expect(record.ok).toBe(false);
	if (record.ok) throw new Error("expected failed fetch record");
	return record;
}
function expectFailure(kind: string, error?: string) {
	return (record: FetchTextResult) => {
		const failed = expectFailed(record);
		expect(failed.failureKind as string).toBe(kind);
		if (error) expect(failed.error).toBe(error);
	};
}
function expectFinalUrl(expected: string) {
	return (record: FetchTextResult) => {
		expect(expectOk(record).finalUrl).toBe(expected);
	};
}
function expectFinalUrlAndBody(expectedUrl: string, expectedBody: string) {
	return (record: FetchTextResult) => {
		const ok = expectOk(record);
		expect(ok.finalUrl).toBe(expectedUrl);
		expect(ok.body).toBe(expectedBody);
	};
}
async function assertFetch(
	url: string,
	check: (result: FetchTextResult) => void | Promise<void>,
	mock: (input: string, headers: Record<string, string>) => Promise<Response>,
	conditional?: Parameters<typeof fetchText>[3],
) {
	await withMockFetch(async () => {
		await check(await fetchText(url, config, undefined, conditional));
	}, mock);
}
function useMultiTestResolver(raw: string) {
	setResolvePublicHttpUrlForTest(async () => ({
		url: new URL(raw),
		hostname: "multi.test",
		address: "127.0.0.2",
		family: 4 as const,
		addresses: loopbackFallbackAddresses,
	}));
}
async function withServer(
	server: ReturnType<typeof createServer>,
	run: (port: number) => Promise<void>,
) {
	const started = await startServer(server);
	if (!started) return;
	try {
		const address = server.address();
		expect(address && typeof address !== "string").toBe(true);
		if (!address || typeof address === "string") {
			throw new Error("server did not bind a TCP port");
		}
		await run(address.port);
	} finally {
		await closeServer(server);
	}
}
function startServer(target: ReturnType<typeof createServer>) {
	return new Promise<boolean>((resolve) => {
		target.once("error", () => resolve(false));
		target.listen(0, "127.0.0.1", () => resolve(true));
	});
}
function closeServer(target: ReturnType<typeof createServer>) {
	return new Promise<void>((ok, no) => target.close((e) => (e ? no(e) : ok())));
}
async function withMockFetch(
	run: () => Promise<void>,
	mock: (input: string, headers: Record<string, string>) => Promise<Response>,
): Promise<void> {
	setFetchTransportForTest(async (input, headers) => {
		const unsafe = validatePublicHttpUrl(input);
		if (unsafe) throw new Error(unsafe);
		const response = await mock(input, headers);
		return {
			url: input,
			status: response.status,
			headers: { get: (name: string) => response.headers.get(name) },
			body: new Uint8Array(await response.arrayBuffer()),
		};
	});
	try {
		await run();
	} finally {
		setFetchTransportForTest(undefined);
	}
}
async function assertRedirectCookie(
	start: string,
	target: string,
	setCookie: string,
	expectCookie: string | undefined,
) {
	const calls: Array<{ url: string; headers: Record<string, string> }> = [];
	await withMockFetch(
		async () => {
			const result = await fetchText(start, config);
			const headers = calls.find((call) => call.url === target)?.headers;
			expectOk(result);
			// biome-ignore lint/complexity/useLiteralKeys: tsconfig requires index access
			expect(headers?.["cookie"]).toBe(expectCookie);
		},
		async (input, headers) => {
			calls.push({ url: input, headers });
			return input === start
				? new Response("", {
						status: 302,
						headers: { location: target, "set-cookie": setCookie },
					})
				: html("Target");
		},
	);
}
