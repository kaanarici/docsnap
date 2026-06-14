import { parseArgs } from "../src/cli/args.ts";
import type { Config, FetchResult } from "../src/core/types.ts";
import { discoverAssetPages } from "../src/discover/assets.ts";
import { crawlScoped } from "../src/discover/crawl.ts";
import { discoverFeed, discoverRelNextPages } from "../src/discover/feed.ts";
import type { Robots } from "../src/discover/robots.ts";
import { discoverSitemaps } from "../src/discover/sitemap.ts";
import { fetchText, setFetchTransportForTest } from "../src/fetch/fetcher.ts";

await discoveryFinalUrlRegression();
await discoveryResourceGateRegression();
await fetchRedirectGateRegression();

async function discoveryFinalUrlRegression() {
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
	assert(feed.length === 0);
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
	assert(crawl.length === 0);
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
			assert(relNext.length === 0);
		},
	);
	assert(relFetched.join(" ") === "https://docs.example.com/page-2");
}

async function discoveryResourceGateRegression() {
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
			assert(sitemaps.length === 0);
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
			assert(assets.length === 0);
		},
	);
	assert(fetched.length === 0);
}

async function fetchRedirectGateRegression() {
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
			assert(!http.ok && http.error === "blocked by robots.txt");
			assert(http.finalUrl === "https://docs.example.com/private");
			assert(http.redirects?.[0]?.type === "http");
			const refresh = await fetchText(
				"https://docs.example.com/refresh",
				config,
				undefined,
				undefined,
				allowResource,
			);
			assert(!refresh.ok && refresh.error === "blocked by robots.txt");
			assert(refresh.finalUrl === "https://docs.example.com/private");
			assert(refresh.redirects?.[0]?.type === "refresh");
		},
	);
	assert(
		fetched.join(" ") ===
			"https://docs.example.com/http https://docs.example.com/refresh",
	);
}

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

function parsedConfig(seed: string): Config {
	const config = parseArgs([seed, "--quiet"]);
	assert(!("help" in config) && !("version" in config));
	return config;
}

function assert(condition: unknown): asserts condition {
	if (!condition) throw new Error("assertion failed");
}
