import { parseArgs } from "../src/cli/args.ts";
import { looksLikeAppShell } from "../src/discover/assets.ts";
import { discoverLlms } from "../src/discover/llms.ts";
import { discoverNav } from "../src/discover/nav.ts";
import { discoverSitemaps } from "../src/discover/sitemap.ts";
import { normalizeUrl } from "../src/discover/url.ts";
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

function assert(condition: unknown): asserts condition {
	if (!condition) throw new Error("assertion failed");
}
