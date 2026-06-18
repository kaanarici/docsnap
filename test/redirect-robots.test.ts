import { describe, expect, test } from "bun:test";
import { buildPipelineConfig, parseArgs } from "../src/cli/args.ts";
import type { FetchResult, PipelineConfig } from "../src/core/types.ts";
import { discoverAssetPages } from "../src/discover/assets.ts";
import { crawlScoped } from "../src/discover/crawl.ts";
import { discoverFeed, discoverRelNextPages } from "../src/discover/feed.ts";
import { discover } from "../src/discover/index.ts";
import { discoverLlms } from "../src/discover/llms.ts";
import type { Robots } from "../src/discover/robots.ts";
import { discoverSitemaps } from "../src/discover/sitemap.ts";
import { fetchText, setFetchTransportForTest } from "../src/fetch/fetcher.ts";
import type { FetchTransport } from "../src/fetch/transport.ts";
import { withWritersideTopic } from "../src/fetch/writerside.ts";

describe("redirect and robots gates", () => {
	test("discovery rejects resources whose final URL is disallowed", async () => {
		const config = parsedConfig("https://docs.example.com/");
		const allowResource = (url: string) => !url.includes("/blocked/");
		const feed = await discoverFeed(
			"https://docs.example.com/feed.xml",
			"https://docs.example.com/",
			"/",
			config,
			{
				accept: () => true,
				allowResource,
				response: fetchedResult(
					"https://docs.example.com/feed.xml",
					"https://docs.example.com/blocked/feed.xml",
					`<rss><channel><item><link>https://docs.example.com/mined</link></item></channel></rss>`,
					"application/rss+xml",
				),
			},
		);
		expect(feed).toHaveLength(0);
		const crawl = await crawlScoped(
			"https://docs.example.com/",
			"/",
			3,
			allowAllRobots(),
			config,
			fetchedResult(
				"https://docs.example.com/",
				"https://docs.example.com/blocked/page",
				`<a href="/mined">mined</a>`,
			),
			allowResource,
		);
		expect(crawl).toHaveLength(0);
		const relFetched: string[] = [];
		await withTransport(
			async (url) => {
				relFetched.push(url);
				if (url.endsWith("/page-2"))
					return response(url, 302, "", "text/html", {
						location: "/blocked/page-2",
					});
				throw new Error("blocked rel-next target fetched");
			},
			async () => {
				const relNext = await discoverRelNextPages(
					`<link rel="next" href="/page-2">`,
					"https://docs.example.com/",
					"https://docs.example.com/",
					"/",
					config,
					{ accept: () => true, allowResource },
				);
				expect(relNext).toHaveLength(0);
			},
		);
		expect(relFetched.join(" ")).toBe("https://docs.example.com/page-2");
	});

	test("discovery does not fetch resources denied by the resource gate", async () => {
		const config = parsedConfig("https://docs.example.com/");
		const fetched: string[] = [];
		await withTransport(
			async (url) => {
				fetched.push(url);
				throw new Error(`disallowed resource fetched: ${url}`);
			},
			async () => {
				const sitemaps = await discoverSitemaps(
					"https://docs.example.com/docs/",
					["https://docs.example.com/sitemap.xml"],
					config,
					{
						limit: 2,
						scope: "/docs/",
						declaredOnly: true,
						accept: () => true,
						allowResource: () => false,
					},
				);
				expect(sitemaps).toHaveLength(0);
				const assets = await discoverAssetPages(
					"https://docs.example.com/",
					`<html><body><div id="app"></div><script src="/app.js"></script></body></html>`,
					config,
					{
						limit: 2,
						scope: "/",
						accept: () => true,
						allowResource: () => false,
					},
				);
				expect(assets).toHaveLength(0);
			},
		);
		expect(fetched).toHaveLength(0);
	});

	test("fetch rejects HTTP and refresh redirects whose targets are disallowed", async () => {
		const config = parsedConfig("https://docs.example.com/");
		const allowResource = (url: string) => !url.endsWith("/private");
		const fetched: string[] = [];
		await withTransport(
			async (url) => {
				fetched.push(url);
				if (url.endsWith("/http"))
					return response(url, 302, "", "text/html", { location: "/private" });
				if (url.endsWith("/refresh"))
					return response(
						url,
						200,
						`<meta http-equiv="refresh" content="0; url=/private">`,
					);
				throw new Error("blocked redirect target fetched");
			},
			async () => {
				const http = await fetchText(
					"https://docs.example.com/http",
					config,
					undefined,
					undefined,
					allowResource,
				);
				expect(http.ok).toBe(false);
				if (http.ok) throw new Error("expected blocked HTTP redirect");
				expect(http.error).toBe("blocked by robots.txt");
				expect(http.finalUrl).toBe("https://docs.example.com/private");
				expect(http.redirects?.[0]?.type).toBe("http");
				const refresh = await fetchText(
					"https://docs.example.com/refresh",
					config,
					undefined,
					undefined,
					allowResource,
				);
				expect(refresh.ok).toBe(false);
				if (refresh.ok) throw new Error("expected blocked refresh redirect");
				expect(refresh.error).toBe("blocked by robots.txt");
				expect(refresh.finalUrl).toBe("https://docs.example.com/private");
				expect(refresh.redirects?.[0]?.type).toBe("refresh");
			},
		);
		expect(fetched.join(" ")).toBe(
			"https://docs.example.com/http https://docs.example.com/refresh",
		);
	});

	test("route fallback denied by robots is blocked instead of not found", async () => {
		const config = parsedConfig("https://docs.example.com/");
		const allowResource = (url: string) => !url.includes("/docs/");
		await withTransport(
			async (url) => {
				if (String(url).endsWith("/guide.md"))
					return response(String(url), 404, "not found");
				throw new Error(`unexpected fetch: ${url}`);
			},
			async () => {
				const result = await fetchText(
					"https://docs.example.com/guide.md",
					config,
					undefined,
					undefined,
					allowResource,
				);
				expect(result.ok).toBe(false);
				if (result.ok) throw new Error("expected blocked route fallback");
				expect(result.error).toBe("blocked by robots.txt");
				expect(result.status).toBe(404);
				expect(result.failureKind).toBe("blocked");
			},
		);
	});

	test("llms discovery rejects redirected llms.txt when final URL is disallowed", async () => {
		const config = parsedConfig("https://docs.example.com/");
		const finalUrl = "https://llmsgate.example/private/llms.txt";
		const fetched: string[] = [];
		await withTransport(
			async (url) => {
				fetched.push(url);
				if (url === "https://llmsgate.example/llms.txt") {
					return response(url, 301, "", "text/plain", { location: finalUrl });
				}
				if (url === finalUrl) {
					throw new Error("robots-disallowed redirected llms.txt was fetched");
				}
				return response(url, 404, "not found", "text/plain");
			},
			async () => {
				const urls = await discoverLlms(
					"https://llmsgate.example/docs/",
					config,
					{
						allowResource: (url) => url !== finalUrl,
					},
				);
				expect(urls).toHaveLength(0);
			},
		);
		expect(fetched).not.toContain(finalUrl);
	});

	test("canonical seed redirect honors the canonical origin robots gate before fetching content", async () => {
		const config = parsedConfig("https://apexblock.example/docs/");
		const fetched: string[] = [];
		await withTransport(
			async (input) => {
				const url = String(input);
				fetched.push(url);
				if (url === "https://apexblock.example/robots.txt") {
					throw new Error("connect ECONNREFUSED apexblock.example:443");
				}
				if (url === "https://apexblock.example/docs/") {
					return response(url, 301, "", "text/plain", {
						location: "https://www.apexblock.example/docs/",
					});
				}
				if (url === "https://www.apexblock.example/robots.txt") {
					return response(url, 200, "User-agent: *\nDisallow: /", "text/plain");
				}
				if (url.startsWith("https://www.apexblock.example/")) {
					throw new Error("disallowed www content fetched before robots gate");
				}
				return response(url, 404, "not found", "text/plain");
			},
			async () => {
				const urls = await discover(config);
				expect(urls).toHaveLength(1);
				expect(urls[0]?.fetched?.ok).toBe(false);
				expect(fetched).toContain("https://www.apexblock.example/robots.txt");
				expect(
					fetched.some(
						(url) =>
							url.startsWith("https://www.apexblock.example/") &&
							!url.endsWith("/robots.txt"),
					),
				).toBe(false);
			},
		);
	});

	test("Writerside topic fetches honor the resource gate", async () => {
		const html = `<html data-topic="/topics/page.json"><body>doc</body></html>`;
		const base = "https://docs.example.com/docs/page";
		const headers = { accept: "text/html", "user-agent": "docsnap" };
		let calls = 0;
		const transport = (async () => {
			calls++;
			return {
				status: 200,
				body: new TextEncoder().encode("{}"),
			} as unknown as Awaited<ReturnType<FetchTransport>>;
		}) as FetchTransport;
		const config = { ...parsedConfig("https://docs.example.com/"), transport };
		const before = calls;
		const blocked = await withWritersideTopic(
			html,
			base,
			headers,
			config,
			() => false,
		);
		expect(calls).toBe(before);
		expect(blocked).toBe(html);
		const beforeAllowed = calls;
		await withWritersideTopic(html, base, headers, config, () => true);
		expect(calls).toBe(beforeAllowed + 1);
	});
});

async function withTransport(
	transport: Parameters<typeof setFetchTransportForTest>[0],
	fn: () => Promise<void>,
) {
	setFetchTransportForTest(transport);
	try {
		await fn();
	} finally {
		setFetchTransportForTest(undefined);
	}
}

function fetchedResult(
	url: string,
	finalUrl: string,
	body: string,
	contentType = "text/html",
): FetchResult {
	return {
		url,
		finalUrl,
		status: 200,
		contentType,
		body,
		ok: true,
		fetchMs: 0,
		redirects:
			url === finalUrl
				? []
				: [{ from: url, to: finalUrl, type: "http", status: 302 }],
	};
}

function response(
	url: string,
	status: number,
	body: string,
	contentType = "text/html",
	headers: Record<string, string> = {},
) {
	const normalized = new Map(
		Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]),
	);
	return {
		url,
		status,
		headers: {
			get: (name: string) =>
				name.toLowerCase() === "content-type"
					? contentType
					: (normalized.get(name.toLowerCase()) ?? null),
			getSetCookie: () => [],
		},
		body: new TextEncoder().encode(body),
	};
}

function allowAllRobots(): Robots {
	return { sitemaps: [], allows: [], disallows: [], allowed: () => true };
}

function parsedConfig(seed: string): PipelineConfig {
	const parsed = parseArgs([seed, "--quiet"]);
	if ("help" in parsed || "version" in parsed) {
		throw new Error("parseArgs returned help/version");
	}
	return buildPipelineConfig(parsed.run);
}
