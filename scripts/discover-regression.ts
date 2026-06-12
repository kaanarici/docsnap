import { parseArgs } from "../src/cli/args.ts";
import type { FetchResult } from "../src/core/types.ts";
import {
	discoverAssetPages,
	looksLikeAppShell,
} from "../src/discover/assets.ts";
import { crawlScoped } from "../src/discover/crawl.ts";
import { discover } from "../src/discover/index.ts";
import { discoverLlms } from "../src/discover/llms.ts";
import { discoverNav } from "../src/discover/nav.ts";
import { loadRobots, parseRobots } from "../src/discover/robots.ts";
import { normalizeUrl, sameScopeLinks } from "../src/discover/url.ts";
import { setFetchTransportForTest } from "../src/fetch/fetcher.ts";

const links = discoverNav(
	`<nav>
		<a class="nav-link" href="/general/downloads">Releases</a>
		<a class="nav-link dropdown-toggle" href="/Document" role="button" data-bs-toggle="dropdown" aria-expanded="false">Documentation</a>
		<ul><li><a class="dropdown-item" href="/docs/latest/">Latest</a></li></ul>
	</nav>`,
	"https://hive.apache.org/",
);

assert(links.includes("https://hive.apache.org/general/downloads"));
assert(links.includes("https://hive.apache.org/docs/latest/"));
assert(!links.includes("https://hive.apache.org/Document"));
assert(normalizeUrl("/mydocs", "https://docs.example.com/") === undefined);
assert(
	normalizeUrl("/managewatches", "https://docs.example.com/") === undefined,
);
assert(
	normalizeUrl("https://user:pass@docs.example.com/private") === undefined,
);
assert(
	sameScopeLinks(
		`1. PagerDuty Operations Cloud [https://www.pagerduty.example/platform/operations-cloud/]: Platform overview.`,
		"https://www.pagerduty.example/llms.txt",
	).includes("https://www.pagerduty.example/platform/operations-cloud/"),
);
assert(
	looksLikeAppShell(`<main></main><script>var zdWebClientConfig={}</script>`),
);

const parsed = parseArgs(["https://docs.example.com/", "-m", "4"]);
assert(!("help" in parsed) && !("version" in parsed));

const seedBlockedConfig = parseArgs([
	"https://blockedseed.example/docs/",
	"-m",
	"3",
]);
assert(!("help" in seedBlockedConfig) && !("version" in seedBlockedConfig));
const seedBlockedFetches: string[] = [];
setFetchTransportForTest(async (input) => {
	const url = String(input);
	seedBlockedFetches.push(url);
	if (url === "https://blockedseed.example/robots.txt") {
		return response(url, 200, "User-agent: *\nDisallow: /docs/", "text/plain");
	}
	if (url === "https://blockedseed.example/docs/") {
		throw new Error("seed fetched before robots gate");
	}
	return response(url, 404, "not found", "text/plain");
});
try {
	const urls = await discover(seedBlockedConfig);
	assert(seedBlockedFetches.length === 1);
	assert(seedBlockedFetches[0] === "https://blockedseed.example/robots.txt");
	assert(urls.length === 1);
	assert(urls[0]?.url === "https://blockedseed.example/docs/");
	assert(urls[0]?.source === "seed");
	assert(urls[0]?.fetched?.ok === false);
	assert(urls[0]?.fetched?.error === "blocked by robots.txt");
	assert(urls[0]?.fetched?.failureKind === "blocked");
} finally {
	setFetchTransportForTest(undefined);
}

const llmsBlockedConfig = parseArgs([
	"https://llmsblocked.example/docs/",
	"-m",
	"2",
]);
assert(!("help" in llmsBlockedConfig) && !("version" in llmsBlockedConfig));
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
try {
	const urls = await discover(llmsBlockedConfig);
	assert(llmsBlockedFetches[0] === "https://llmsblocked.example/robots.txt");
	assert(!llmsBlockedFetches.some((url) => url.endsWith("/llms.txt")));
	assert(urls.some((item) => item.url === "https://llmsblocked.example/docs/"));
	assert(
		urls.some((item) => item.url === "https://llmsblocked.example/docs/guide"),
	);
	assert(!urls.some((item) => item.source === "llms"));
} finally {
	setFetchTransportForTest(undefined);
}

const relNextConfig = parseArgs(["https://page.example.com/blog/", "-m", "10"]);
assert(!("help" in relNextConfig) && !("version" in relNextConfig));
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
try {
	const urls = await discover(relNextConfig);
	assert(relNextFetches.length === 3);
	assert(relNextFetches.at(-1) === "https://page.example.com/blog/?page=4");
	assert(
		urls.some((item) => item.url === "https://page.example.com/blog/post-2"),
	);
	assert(
		urls.some((item) => item.url === "https://page.example.com/blog/post-4"),
	);
	assert(
		!urls.some((item) => item.url === "https://page.example.com/blog/post-5"),
	);
} finally {
	setFetchTransportForTest(undefined);
}

const rateLimitedConfig = { ...parsed, concurrency: 8, perOrigin: 2 };
const crawlSeed = "https://crawl.example/docs/";
let crawlActive = 0;
let crawlPeak = 0;
setFetchTransportForTest(async (input) => {
	crawlActive++;
	crawlPeak = Math.max(crawlPeak, crawlActive);
	await Bun.sleep(20);
	crawlActive--;
	return response(String(input), 200, "<main>Child page</main>", "text/html");
});
try {
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
	assert(pages.length === 6);
	assert(crawlPeak <= rateLimitedConfig.perOrigin);
} finally {
	setFetchTransportForTest(undefined);
}

let assetActive = 0;
let assetPeak = 0;
setFetchTransportForTest(async (input) => {
	assetActive++;
	assetPeak = Math.max(assetPeak, assetActive);
	await Bun.sleep(20);
	assetActive--;
	return response(
		String(input),
		200,
		"console.log('chunk')",
		"text/javascript",
	);
});
try {
	await discoverAssetPages(
		"https://assets.example/docs/",
		`<html><body><div id="app"></div>${Array.from(
			{ length: 6 },
			(_, index) => `<script src="/assets/${index + 1}.js"></script>`,
		).join("")}</body></html>`,
		rateLimitedConfig,
		{ limit: 3, scope: "/", accept: () => true },
	);
	assert(assetPeak <= rateLimitedConfig.perOrigin);
} finally {
	setFetchTransportForTest(undefined);
}

setFetchTransportForTest(async (input) => {
	return {
		url: String(input),
		status: 200,
		headers: {
			get: (name) => (name === "content-type" ? "text/markdown" : null),
			getSetCookie: () => [],
		},
		body: new TextEncoder().encode(`# Docs

- [Release notes](releases/index.html.md): * [Upgrading](upgrading.md)
- [Usage guide](topics/index.html.md): * [Pages](pages.md)
- German (Deutsch) - 133 pages - /docs/de - Visit website for content
- [API](api/index.md): API reference`),
	};
});
try {
	const urls = await discoverLlms("https://docs.example.com/", parsed);
	assert(urls.includes("https://docs.example.com/llms.txt"));
	assert(!urls.includes("https://docs.example.com/upgrading.md"));
	assert(!urls.includes("https://docs.example.com/pages.md"));
	assert(!urls.includes("https://docs.example.com/docs/de"));
} finally {
	setFetchTransportForTest(undefined);
}

let failedLlmsProbes = 0;
const llmsCache = new Map();
setFetchTransportForTest(async (input) => {
	failedLlmsProbes++;
	if (String(input) === "https://slow.example.com/llms.txt") {
		return {
			url: String(input),
			status: 301,
			headers: {
				get: (name) =>
					name === "location" ? "https://www.slow.example.com/llms.txt" : null,
				getSetCookie: () => [],
			},
			body: new Uint8Array(),
		};
	}
	return {
		url: String(input),
		status: 503,
		headers: {
			get: (name) => (name === "content-type" ? "text/plain" : null),
			getSetCookie: () => [],
		},
		body: new TextEncoder().encode("unavailable"),
	};
});
try {
	const first = await discoverLlms("https://slow.example.com/", parsed, {
		cache: llmsCache,
	});
	const second = await discoverLlms("https://www.slow.example.com/", parsed, {
		cache: llmsCache,
	});
	assert(first.length === 0);
	assert(second.length === 0);
	assert(failedLlmsProbes === 2);
} finally {
	setFetchTransportForTest(undefined);
}

const redirectedLlmsConfig = parseArgs([
	"https://gofiber.example/docs/",
	"-m",
	"2",
]);
assert(
	!("help" in redirectedLlmsConfig) && !("version" in redirectedLlmsConfig),
);
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
try {
	const urls = await discoverLlms(
		"https://gofiber.example/docs/",
		redirectedLlmsConfig,
	);
	assert(urls.includes("https://gofiber.example/docs/llms.txt"));
	assert(urls.includes("https://gofiber.example/docs/casbin/casbin"));
	assert(!urls.includes("https://gofiber.example/casbin/casbin"));
	const discovered = await discover(redirectedLlmsConfig);
	assert(discovered.length === 2);
	assert(discovered[0]?.url === "https://gofiber.example/docs/llms.txt");
	assert(discovered[1]?.url === "https://gofiber.example/docs/casbin/casbin");
} finally {
	setFetchTransportForTest(undefined);
}

const blankLineRobots = parseRobots(
	"User-agent: docsnap\n\nDisallow: /private\n\nUser-agent: *\nAllow: /",
	"https://robots.example",
	parsed.userAgent,
);
assert(!blankLineRobots.allowed("https://robots.example/private/page"));
assert(blankLineRobots.allowed("https://robots.example/public/page"));

setFetchTransportForTest(async (input) =>
	response(String(input), 404, "not found", "text/plain"),
);
try {
	const robots404 = await loadRobots("https://robots404.example", {
		...parsed,
		retryHttp: false,
	});
	assert(robots404.allowed("https://robots404.example/private"));
} finally {
	setFetchTransportForTest(undefined);
}

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
try {
	const urls = await discover(robotsClosedConfig);
	assert(robotsClosedFetches.length === 1);
	assert(robotsClosedFetches[0] === "https://robotsfail.example/robots.txt");
	assert(urls.length === 1);
	assert(urls[0]?.url === "https://robotsfail.example/docs/");
	assert(urls[0]?.fetched?.ok === false);
	assert(urls[0]?.fetched?.error === "blocked by robots.txt");
} finally {
	setFetchTransportForTest(undefined);
}

function assert(condition: unknown): asserts condition {
	if (!condition) throw new Error("assertion failed");
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
