import { parseArgs } from "../src/cli/args.ts";
import type { Config, FetchResult } from "../src/core/types.ts";
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

await discoveryFinalUrlRegression();
await discoveryResourceGateRegression();
await fetchRedirectGateRegression();
await routeFallbackBlockedRegression();
await llmsRedirectGateRegression();
await canonicalSeedRobotsGateRegression();
await writersideTopicGateRegression();

// a .md route fallback denied by robots must classify as "blocked", not as the
// original 404's "not_found": the cause is "do not fetch", not "stale URL"
async function routeFallbackBlockedRegression() {
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
			assert(!result.ok && result.error === "blocked by robots.txt");
			assert(result.status === 404);
			assert(result.failureKind === "blocked");
		},
	);
}

// apex refuses robots and redirects the seed to a related www that Disallows
// everything: the canonical-origin probe must load and honor the www origin's
// robots BEFORE any www content is fetched, never requesting the cross-origin
// seed body under a Disallow.
async function canonicalSeedRobotsGateRegression() {
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
			assert(urls.length === 1);
			assert(urls[0]?.fetched?.ok === false);
			assert(fetched.includes("https://www.apexblock.example/robots.txt"));
			assert(
				!fetched.some(
					(url) =>
						url.startsWith("https://www.apexblock.example/") &&
						!url.endsWith("/robots.txt"),
				),
			);
		},
	);
}

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

async function llmsRedirectGateRegression() {
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
			assert(urls.length === 0);
		},
	);
	assert(!fetched.includes(finalUrl));
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

async function writersideTopicGateRegression() {
	const config = parsedConfig("https://docs.example.com/");
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
	// a robots-disallowed topic path must not be fetched
	const before = calls;
	const blocked = await withWritersideTopic(
		html,
		base,
		headers,
		config,
		transport,
		() => false,
	);
	assert(calls === before);
	assert(blocked === html);
	// an allowed topic is fetched
	const beforeAllowed = calls;
	await withWritersideTopic(html, base, headers, config, transport, () => true);
	assert(calls === beforeAllowed + 1);
}

function parsedConfig(seed: string): Config {
	const config = parseArgs([seed, "--quiet"]);
	assert(!("help" in config) && !("version" in config));
	return config;
}

function assert(condition: unknown): asserts condition {
	if (!condition) throw new Error("assertion failed");
}
