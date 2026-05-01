import { parseArgs } from "../src/cli/args.ts";
import { looksLikeAppShell } from "../src/discover/assets.ts";
import { discover } from "../src/discover/index.ts";
import { discoverLlms } from "../src/discover/llms.ts";
import { discoverNav } from "../src/discover/nav.ts";
import { discoverSitemaps } from "../src/discover/sitemap.ts";
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
			"https://docs.gofiber.example/llms.txt",
		);
	}
	if (url === "https://docs.gofiber.example/llms.txt") {
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
	assert(urls.includes("https://docs.gofiber.example/llms.txt"));
	assert(urls.includes("https://docs.gofiber.example/casbin/casbin"));
	assert(!urls.includes("https://gofiber.example/casbin/casbin"));
	const discovered = await discover(redirectedLlmsConfig);
	assert(discovered.length === 2);
	assert(discovered[0]?.url === "https://docs.gofiber.example/llms.txt");
	assert(discovered[1]?.url === "https://docs.gofiber.example/casbin/casbin");
} finally {
	setFetchTransportForTest(undefined);
}

const sitemapFetches: string[] = [];
setFetchTransportForTest(async (input) => {
	const url = String(input);
	sitemapFetches.push(url);
	const body = url.endsWith("/sitemap.xml")
		? `<sitemapindex><sitemap><loc>https://docs.example.com/sitemappart/1.xml</loc></sitemap><sitemap><loc>https://docs.example.com/sitemappart/2.xml</loc></sitemap></sitemapindex>`
		: `<urlset><url><loc>https://docs.example.com/docs/intro</loc></url></urlset>`;
	return {
		url,
		status: 200,
		headers: {
			get: (name) => (name === "content-type" ? "application/xml" : null),
			getSetCookie: () => [],
		},
		body: new TextEncoder().encode(body),
	};
});
try {
	const urls = await discoverSitemaps(
		"https://docs.example.com/docs/",
		[],
		parsed,
		{
			limit: 1,
			scope: "/docs/",
			accept: () => true,
		},
	);
	assert(urls.length === 1);
	assert(urls[0] === "https://docs.example.com/docs/intro");
	assert(
		!sitemapFetches.includes("https://docs.example.com/sitemappart/1.xml"),
	);
} finally {
	setFetchTransportForTest(undefined);
}

const languageConfig = parseArgs(["https://eu.example/", "-m", "2"]);
assert(!("help" in languageConfig) && !("version" in languageConfig));
setFetchTransportForTest(async (input) => {
	const url = String(input);
	if (url.endsWith("/robots.txt")) {
		return response(
			url,
			200,
			"Sitemap: https://commission.example/sitemap.xml",
			"text/plain",
		);
	}
	if (url.endsWith("/sitemap.xml")) {
		return response(
			url,
			200,
			`<urlset><url><loc>https://commission.example/index_en</loc></url></urlset>`,
			"application/xml",
		);
	}
	if (url === "https://eu.example/") {
		return response(
			url,
			302,
			"",
			"text/html",
			"https://commission.example/select-language?destination=/node/1",
		);
	}
	if (
		url === "https://commission.example/select-language?destination=/node/1"
	) {
		return response(
			url,
			200,
			`<html><body class="path-select-language"><main></main></body></html>`,
		);
	}
	return response(url, 404, "not found", "text/plain");
});
try {
	const urls = await discover(languageConfig);
	assert(urls.length === 1);
	assert(urls[0]?.url === "https://commission.example/index_en");
	assert(urls[0]?.source === "sitemap");
} finally {
	setFetchTransportForTest(undefined);
}

const urlsetSitemapFetches: string[] = [];
setFetchTransportForTest(async (input) => {
	const url = String(input);
	urlsetSitemapFetches.push(url);
	if (url.endsWith("/documentation/sitemap.xml")) {
		return response(
			url,
			200,
			`<urlset>
				<url><loc>https://dev.example/community/api/documentation/sitemaps/fortnite/sitemap_99.xml</loc></url>
				<url><loc>https://dev.example/community/api/documentation/sitemaps/unreal_engine/sitemap_1.xml</loc></url>
			</urlset>`,
			"application/xml",
		);
	}
	if (url.endsWith("/sitemap_1.xml")) {
		return response(
			url,
			200,
			`<urlset><url><loc>https://dev.example/documentation/en-us/unreal-engine/installing-unreal-engine</loc></url></urlset>`,
			"application/xml",
		);
	}
	return response(url, 404, "not found", "text/plain");
});
try {
	const urls = await discoverSitemaps(
		"https://dev.example/documentation/en-us/unreal-engine/",
		["https://dev.example/documentation/sitemap.xml"],
		parsed,
		{
			limit: 1,
			scope: "/documentation/unreal-engine/",
			accept: () => true,
		},
	);
	assert(urls.length === 1);
	assert(
		urls[0] ===
			"https://dev.example/documentation/en-us/unreal-engine/installing-unreal-engine",
	);
	assert(
		urlsetSitemapFetches.includes(
			"https://dev.example/community/api/documentation/sitemaps/unreal_engine/sitemap_1.xml",
		),
	);
	assert(
		!urlsetSitemapFetches.includes(
			"https://dev.example/community/api/documentation/sitemaps/fortnite/sitemap_99.xml",
		),
	);
} finally {
	setFetchTransportForTest(undefined);
}

let blockedSitemapChildren = 0;
setFetchTransportForTest(async (input) => {
	const url = String(input);
	if (url.endsWith("/documentation/sitemap.xml")) {
		const children = Array.from(
			{ length: 6 },
			(_, index) =>
				`<sitemap><loc>https://blocked.example/documentation/sitemap_${index + 1}.xml</loc></sitemap>`,
		).join("");
		return response(url, 200, `<sitemapindex>${children}</sitemapindex>`);
	}
	if (/\/sitemap_\d+\.xml$/.test(url)) {
		blockedSitemapChildren++;
		return response(url, 403, "blocked", "text/html");
	}
	return response(url, 404, "not found", "text/plain");
});
try {
	const urls = await discoverSitemaps(
		"https://blocked.example/documentation/guide/",
		["https://blocked.example/documentation/sitemap.xml"],
		parsed,
		{
			limit: 1,
			scope: "/documentation/",
			accept: () => true,
		},
	);
	assert(urls.length === 0);
	assert(blockedSitemapChildren === 5);
} finally {
	setFetchTransportForTest(undefined);
}

function assert(condition: unknown): asserts condition {
	if (!condition) throw new Error("assertion failed");
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
