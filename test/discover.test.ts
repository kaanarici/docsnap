import { afterEach, describe, expect, test } from "bun:test";
import { buildPipelineConfig, parseArgs } from "../src/cli/args.ts";
import type { FetchResult } from "../src/core/types.ts";
import { discoverAssetPages } from "../src/discover/assets.ts";
import { crawlScoped } from "../src/discover/crawl.ts";
import { discover } from "../src/discover/index.ts";
import { discoverLlms } from "../src/discover/llms.ts";
import { discoverNav } from "../src/discover/nav.ts";
import { loadRobots, parseRobots } from "../src/discover/robots.ts";
import { normalizeUrl, sameScopeLinks } from "../src/discover/url.ts";
import { looksLikeAppShell } from "../src/extract/app-shell.ts";
import { setFetchTransportForTest } from "../src/fetch/fetcher.ts";

const parsed = parseConfig(["https://docs.example.com/", "-m", "4"]);
const rateLimitedConfig = { ...parsed, concurrency: 8, perOrigin: 2 };

afterEach(() => {
	setFetchTransportForTest(undefined);
});

describe("navigation and URL filtering", () => {
	test("nav discovery keeps real links and drops dropdown toggles", () => {
		const links = discoverNav(
			`<nav>
		<a class="nav-link" href="/general/downloads">Releases</a>
		<a class="nav-link dropdown-toggle" href="/Document" role="button" data-bs-toggle="dropdown" aria-expanded="false">Documentation</a>
		<ul><li><a class="dropdown-item" href="/docs/latest/">Latest</a></li></ul>
	</nav>`,
			"https://hive.apache.org/",
		);

		expect(links).toContain("https://hive.apache.org/general/downloads");
		expect(links).toContain("https://hive.apache.org/docs/latest/");
		expect(links).not.toContain("https://hive.apache.org/Document");
	});

	test("URL normalization rejects documentation-management false positives and credentials", () => {
		expect(normalizeUrl("/mydocs", "https://docs.example.com/")).toBe(
			undefined,
		);
		expect(normalizeUrl("/managewatches", "https://docs.example.com/")).toBe(
			undefined,
		);
		expect(normalizeUrl("https://user:pass@docs.example.com/private")).toBe(
			undefined,
		);
	});

	test("same-scope links include bracketed llms.txt URLs", () => {
		expect(
			sameScopeLinks(
				`1. PagerDuty Operations Cloud [https://www.pagerduty.example/platform/operations-cloud/]: Platform overview.`,
				"https://www.pagerduty.example/llms.txt",
			),
		).toContain("https://www.pagerduty.example/platform/operations-cloud/");
	});

	test("empty static root with Zendesk config looks like an app shell", () => {
		expect(
			looksLikeAppShell(
				`<main></main><script>var zdWebClientConfig={}</script>`,
			),
		).toBe(true);
	});
});

describe("robots-gated discovery", () => {
	test("seed fetch is blocked before the disallowed seed URL is requested", async () => {
		const seedBlockedConfig = maxConfig("https://blockedseed.example/docs/", 3);
		const seedBlockedFetches: string[] = [];
		setFetchTransportForTest(async (input) => {
			const url = String(input);
			seedBlockedFetches.push(url);
			if (url === "https://blockedseed.example/robots.txt") {
				return response(
					url,
					200,
					"User-agent: *\nDisallow: /docs/",
					"text/plain",
				);
			}
			if (url === "https://blockedseed.example/docs/") {
				throw new Error("seed fetched before robots gate");
			}
			return response(url, 404, "not found", "text/plain");
		});

		const urls = await discover(seedBlockedConfig);
		expect(seedBlockedFetches[0]).toBe(
			"https://blockedseed.example/robots.txt",
		);
		expect(
			seedBlockedFetches.every(
				(url) => url.endsWith("/robots.txt") || url.endsWith("/llms.txt"),
			),
		).toBe(true);
		expect(urls).toHaveLength(1);
		expect(urls[0]?.url).toBe("https://blockedseed.example/docs/");
		expect(urls[0]?.source).toBe("seed");
		expect(urls[0]?.fetched?.ok).toBe(false);
		expect(urls[0]?.fetched?.error).toBe("blocked by robots.txt");
		expect(urls[0]?.fetched?.failureKind).toBe("blocked");
	});

	test("llms probes obey robots while seed navigation still runs", async () => {
		const llmsBlockedConfig = maxConfig("https://llmsblocked.example/docs/", 2);
		const llmsBlockedFetches: string[] = [];
		setFetchTransportForTest(async (input) => {
			const url = String(input);
			llmsBlockedFetches.push(url);
			if (url === "https://llmsblocked.example/robots.txt") {
				return response(
					url,
					200,
					"User-agent: *\nDisallow: /llms.txt\nDisallow: /docs/llms.txt",
					"text/plain",
				);
			}
			if (url.endsWith("/llms.txt")) {
				throw new Error("llms.txt fetched despite robots gate");
			}
			if (url === "https://llmsblocked.example/docs/") {
				return response(
					url,
					200,
					`<html><body><main><a href="/docs/guide">Guide</a></main></body></html>`,
				);
			}
			return response(url, 404, "not found", "text/plain");
		});

		const urls = await discover(llmsBlockedConfig);
		expect(llmsBlockedFetches[0]).toBe(
			"https://llmsblocked.example/robots.txt",
		);
		expect(llmsBlockedFetches.some((url) => url.endsWith("/llms.txt"))).toBe(
			false,
		);
		expect(
			urls.some((item) => item.url === "https://llmsblocked.example/docs/"),
		).toBe(true);
		expect(
			urls.some(
				(item) => item.url === "https://llmsblocked.example/docs/guide",
			),
		).toBe(true);
		expect(urls.some((item) => item.source === "llms")).toBe(false);
	});

	test("robots 404 allows crawling", async () => {
		setFetchTransportForTest(async (input) =>
			response(String(input), 404, "not found", "text/plain"),
		);

		const robots404 = await loadRobots("https://robots404.example", {
			...parsed,
			retryHttp: false,
		});
		expect(robots404.allowed("https://robots404.example/private")).toBe(true);
	});

	test("robots 5xx closes the origin before seed fetch", async () => {
		const robotsClosedConfig = {
			...parsed,
			seedUrl: "https://robotsfail.example/docs/",
			max: 3,
			maxExplicit: true,
			retryHttp: false,
		};
		const robotsClosedFetches: string[] = [];
		setFetchTransportForTest(async (input) => {
			const url = String(input);
			robotsClosedFetches.push(url);
			if (url.endsWith("/robots.txt"))
				return response(url, 503, "unavailable", "text/plain");
			if (url === "https://robotsfail.example/docs/")
				throw new Error("seed fetched after robots 5xx closed the origin");
			return response(url, 404, "not found", "text/plain");
		});

		const urls = await discover(robotsClosedConfig);
		expect(robotsClosedFetches).toHaveLength(1);
		expect(robotsClosedFetches[0]).toBe(
			"https://robotsfail.example/robots.txt",
		);
		expect(urls).toHaveLength(1);
		expect(urls[0]?.url).toBe("https://robotsfail.example/docs/");
		expect(urls[0]?.fetched?.ok).toBe(false);
		expect(urls[0]?.fetched?.error).toBe("blocked by robots.txt");
	});
});

describe("pagination, crawling, and asset discovery limits", () => {
	test("rel=next pagination follows the page window and stops before page 5", async () => {
		const relNextConfig = maxConfig("https://page.example.com/blog/", 10);
		const relNextFetches: string[] = [];
		setFetchTransportForTest(async (input) => {
			const url = String(input);
			if (url.endsWith("/llms.txt") || url.endsWith("/robots.txt"))
				return response(url, 404, "not found", "text/plain");
			if (url === "https://page.example.com/blog/") {
				return response(
					url,
					200,
					`<html><head><link rel="next" href="/blog/?page=2"></head><body><main>Blog</main></body></html>`,
				);
			}
			if (url.includes("/blog/?page=")) {
				relNextFetches.push(url);
				const page = Number(new URL(url).searchParams.get("page"));
				return response(
					url,
					200,
					`<html><head><link rel="next" href="/blog/?page=${page + 1}"></head><body><main><a href="/blog/post-${page}">Post ${page}</a></main></body></html>`,
				);
			}
			return response(url, 404, "not found", "text/plain");
		});

		const urls = await discover(relNextConfig);
		expect(relNextFetches).toHaveLength(3);
		expect(relNextFetches.at(-1)).toBe("https://page.example.com/blog/?page=4");
		expect(
			urls.some((item) => item.url === "https://page.example.com/blog/post-2"),
		).toBe(true);
		expect(
			urls.some((item) => item.url === "https://page.example.com/blog/post-4"),
		).toBe(true);
		expect(
			urls.some((item) => item.url === "https://page.example.com/blog/post-5"),
		).toBe(false);
	});

	test("scoped crawl respects the per-origin concurrency limit", async () => {
		const crawlSeed = "https://crawl.example/docs/";
		const crawlPeak = installDelayedTransport("<main>Child page</main>");
		const first = okFetch(
			crawlSeed,
			Array.from(
				{ length: 6 },
				(_, index) => `<a href="/docs/${index + 1}">Page ${index + 1}</a>`,
			).join(""),
		);
		const pages = await crawlScoped(
			crawlSeed,
			"/",
			6,
			{ sitemaps: [], allows: [], disallows: [], allowed: () => true },
			rateLimitedConfig,
			first,
		);
		expect(pages).toHaveLength(6);
		expect(crawlPeak()).toBeLessThanOrEqual(rateLimitedConfig.perOrigin);
	});

	test("asset text mining respects the per-origin concurrency limit", async () => {
		const assetPeak = installDelayedTransport(
			"console.log('chunk')",
			"text/javascript",
		);
		await discoverAssetPages(
			"https://assets.example/docs/",
			`<html><body><div id="app"></div>${Array.from(
				{ length: 6 },
				(_, index) => `<script src="/assets/${index + 1}.js"></script>`,
			).join("")}</body></html>`,
			rateLimitedConfig,
			{ limit: 3, scope: "/", accept: () => true },
		);
		expect(assetPeak()).toBeLessThanOrEqual(rateLimitedConfig.perOrigin);
	});
});

describe("llms.txt discovery", () => {
	test("markdown llms.txt keeps index URLs and drops nested markdown bullets", async () => {
		setFetchTransportForTest(async (input) =>
			response(
				String(input),
				200,
				`# Docs

- [Release notes](releases/index.html.md): * [Upgrading](upgrading.md)
- [Usage guide](topics/index.html.md): * [Pages](pages.md)
- German (Deutsch) - 133 pages - /docs/de - Visit website for content
- [API](api/index.md): API reference`,
				"text/markdown",
			),
		);

		const urls = await discoverLlms("https://docs.example.com/", parsed);
		expect(urls).toContain("https://docs.example.com/llms.txt");
		expect(urls).not.toContain("https://docs.example.com/upgrading.md");
		expect(urls).not.toContain("https://docs.example.com/pages.md");
		expect(urls).not.toContain("https://docs.example.com/docs/de");
	});

	test("failed llms probes are cached across redirect-normalized hosts", async () => {
		let failedLlmsProbes = 0;
		const llmsCache = new Map();
		setFetchTransportForTest(async (input) => {
			const url = String(input);
			failedLlmsProbes++;
			if (url === "https://slow.example.com/llms.txt")
				return response(
					url,
					301,
					"",
					"text/plain",
					"https://www.slow.example.com/llms.txt",
				);
			return response(url, 503, "unavailable", "text/plain");
		});

		const first = await discoverLlms("https://slow.example.com/", parsed, {
			cache: llmsCache,
		});
		const second = await discoverLlms("https://www.slow.example.com/", parsed, {
			cache: llmsCache,
		});
		expect(first).toHaveLength(0);
		expect(second).toHaveLength(0);
		expect(failedLlmsProbes).toBe(2);
	});

	test("redirected root llms.txt preserves the redirected docs scope", async () => {
		const redirectedLlmsConfig = maxConfig("https://gofiber.example/docs/", 2);
		setFetchTransportForTest(async (input) => {
			const url = String(input);
			if (url === "https://gofiber.example/llms.txt") {
				return response(
					url,
					301,
					"",
					"text/plain",
					"https://gofiber.example/docs/llms.txt",
				);
			}
			if (url === "https://gofiber.example/docs/llms.txt") {
				return response(
					url,
					200,
					`# Fiber\n\n- [Casbin](casbin/casbin): Release`,
					"text/markdown",
				);
			}
			return response(url, 404, "not found", "text/plain");
		});

		const urls = await discoverLlms(
			"https://gofiber.example/docs/",
			redirectedLlmsConfig,
		);
		expect(urls).toContain("https://gofiber.example/docs/llms.txt");
		expect(urls).toContain("https://gofiber.example/docs/casbin/casbin");
		expect(urls).not.toContain("https://gofiber.example/casbin/casbin");
		const discovered = await discover(redirectedLlmsConfig);
		expect(discovered).toHaveLength(2);
		expect(discovered[0]?.url).toBe("https://gofiber.example/docs/llms.txt");
		expect(discovered[1]?.url).toBe(
			"https://gofiber.example/docs/casbin/casbin",
		);
	});
});

describe("robots rule parsing", () => {
	test("blank lines do not end matching user-agent groups", () => {
		const blankLineRobots = parseRobots(
			"User-agent: docsnap\n\nDisallow: /private\n\nUser-agent: *\nAllow: /",
			"https://robots.example",
			parsed.userAgent,
		);
		expect(blankLineRobots.allowed("https://robots.example/private/page")).toBe(
			false,
		);
		expect(blankLineRobots.allowed("https://robots.example/public/page")).toBe(
			true,
		);
	});

	test("wildcard and suffix rules match expected paths quickly", () => {
		const robotsRuleStart = performance.now();
		for (const [rule, path, expectedAllowed] of [
			["/private", "/private/x", false],
			["/private", "/priv", true],
			["/a*z", "/abcz", false],
			["/a*z", "/abc", true],
			["/a*z$", "/abcz", false],
			["/a*z$", "/abczq", true],
			["/a*z$", "/azqz", false],
			["/*.pdf$", "/x/doc.pdf", false],
			["/*.pdf$", "/x/doc.pdfx", true],
			["/a**b", "/a-b", false],
			["/*", "/anything", false],
		] as const) {
			const robots = parseRobots(
				`User-agent: *\nDisallow: ${rule}`,
				"https://robots.example",
				parsed.userAgent,
			);
			expect(robots.allowed(`https://robots.example${path}`)).toBe(
				expectedAllowed,
			);
		}
		const pathologicalRobots = parseRobots(
			`User-agent: *\nDisallow: /${"a*".repeat(20)}Z$`,
			"https://robots.example",
			parsed.userAgent,
		);
		expect(
			pathologicalRobots.allowed(
				`https://robots.example/${"a".repeat(10_000)}`,
			),
		).toBe(true);
		expect(performance.now() - robotsRuleStart).toBeLessThan(1000);
	});
});

describe("single-page discovery", () => {
	test("--page keeps the exact public page query and drops the fragment", async () => {
		const pageQueryConfig = parseConfig([
			"https://docs.example.com/page?version=2#frag",
			"--page",
		]);
		setFetchTransportForTest(async (input) => {
			const url = String(input);
			if (url === "https://docs.example.com/robots.txt")
				return response(url, 200, "User-agent: *\nAllow: /", "text/plain");
			throw new Error(`unexpected fetch in --page discovery: ${url}`);
		});

		const urls = await discover(pageQueryConfig);
		expect(urls).toHaveLength(1);
		expect(urls[0]?.url).toBe("https://docs.example.com/page?version=2");
	});
});

function parseConfig(args: string[]) {
	const parsed = parseArgs(args);
	if ("help" in parsed || "version" in parsed) {
		throw new Error("parseArgs returned help/version");
	}
	return buildPipelineConfig(parsed.run);
}

function maxConfig(seedUrl: string, max: number) {
	return parseConfig([seedUrl, "-m", String(max)]);
}

function okFetch(url: string, body: string): FetchResult {
	return {
		url,
		finalUrl: url,
		redirects: [],
		status: 200,
		contentType: "text/html",
		body,
		ok: true,
		fetchMs: 1,
	};
}

function installDelayedTransport(body: string, contentType = "text/html") {
	let active = 0;
	let peak = 0;
	setFetchTransportForTest(async (input) => {
		active++;
		peak = Math.max(peak, active);
		await Bun.sleep(20);
		active--;
		return response(String(input), 200, body, contentType);
	});
	return () => peak;
}

function response(
	url: string,
	status: number,
	body: string,
	contentType = "text/html",
	location?: string,
) {
	return {
		url,
		status,
		headers: {
			get: (name: string) =>
				name === "content-type"
					? contentType
					: name === "location"
						? (location ?? null)
						: null,
			getSetCookie: () => [],
		},
		body: new TextEncoder().encode(body),
	};
}
