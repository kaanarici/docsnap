import { parseArgs } from "../src/cli/args.ts";
import { discover } from "../src/discover/index.ts";
import { discoverSitemaps } from "../src/discover/sitemap.ts";
import { setFetchTransportForTest } from "../src/fetch/fetcher.ts";

const parsed = parseArgs(["https://docs.example.com/", "-m", "4"]);
assert(!("help" in parsed) && !("version" in parsed));
const rateLimitedConfig = { ...parsed, concurrency: 8, perOrigin: 2 };

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

// ReDoS guard: a seed path segment is attacker-controllable and must not be
// interpolated into a backtracking RegExp when ranking sitemap-index children
setFetchTransportForTest(async (input) => {
	const url = String(input);
	const longPath = `${"a".repeat(40)}b`;
	const body = url.endsWith("/sitemap.xml")
		? `<sitemapindex>${Array.from(
				{ length: 20 },
				(_, i) =>
					`<sitemap><loc>https://redos.example/${longPath}-${i}.xml</loc></sitemap>`,
			).join("")}</sitemapindex>`
		: `<urlset></urlset>`;
	return {
		url,
		status: 200,
		headers: {
			get: (name: string) =>
				name === "content-type" ? "application/xml" : null,
			getSetCookie: () => [],
		},
		body: new TextEncoder().encode(body),
	};
});
try {
	const start = performance.now();
	await discoverSitemaps(
		"https://redos.example/",
		["https://redos.example/sitemap.xml"],
		rateLimitedConfig,
		{ limit: 5, scope: "/(a+)+/", accept: () => true },
	);
	// malicious "(a+)+" scope must not build a backtracking regex
	const elapsed = performance.now() - start;
	assert(elapsed < 2000);
} finally {
	setFetchTransportForTest(undefined);
}

const scopedSitemapFetches: string[] = [];
setFetchTransportForTest(async (input) => {
	const url = String(input);
	scopedSitemapFetches.push(url);
	if (url.endsWith("/us-en.sitemap.xml")) {
		return response(
			url,
			200,
			`<urlset><url><loc>https://vendor.example.com/us-en/privacy</loc></url></urlset>`,
			"application/xml",
		);
	}
	return response(url, 200, `<urlset></urlset>`, "application/xml");
});
try {
	const urls = await discoverSitemaps(
		"https://vendor.example.com/us-en",
		["https://vendor.example.com/broad-sitemap.xml"],
		parsed,
		{
			limit: 1,
			scope: "/us-en/",
			accept: (url) => url.includes("/us-en/"),
		},
	);
	assert(urls[0] === "https://vendor.example.com/us-en/privacy");
	assert(
		!scopedSitemapFetches.includes(
			"https://vendor.example.com/broad-sitemap.xml",
		),
	);
} finally {
	setFetchTransportForTest(undefined);
}

const localeSitemapFetches: string[] = [];
setFetchTransportForTest(async (input) => {
	const url = String(input);
	localeSitemapFetches.push(url);
	if (url.endsWith("/sitemap.xml")) {
		return response(
			url,
			200,
			`<sitemapindex>
				<sitemap><loc>https://vendor.example.com/support/sitemap-1.xml</loc></sitemap>
				<sitemap><loc>https://vendor.example.com/href-sitemap-en-us.xml</loc></sitemap>
			</sitemapindex>`,
			"application/xml",
		);
	}
	if (url.endsWith("/href-sitemap-en-us.xml")) {
		return response(
			url,
			200,
			`<urlset><url><loc>https://vendor.example.com/us-en/docs/privacy</loc></url></urlset>`,
			"application/xml",
		);
	}
	return response(url, 200, `<urlset></urlset>`, "application/xml");
});
try {
	const urls = await discoverSitemaps(
		"https://vendor.example.com/us-en/",
		[],
		parsed,
		{
			limit: 1,
			scope: "/us-en/",
			accept: (url) => url.includes("/us-en/"),
		},
	);
	assert(urls[0] === "https://vendor.example.com/us-en/docs/privacy");
	assert(
		!localeSitemapFetches.includes(
			"https://vendor.example.com/support/sitemap-1.xml",
		),
	);
} finally {
	setFetchTransportForTest(undefined);
}

const malformedIndexFetches: string[] = [];
setFetchTransportForTest(async (input) => {
	const url = String(input);
	malformedIndexFetches.push(url);
	return response(
		url,
		200,
		`<sitemapindex>
			<sitemap><loc>https://app.example.com/route</loc></sitemap>
			<sitemap><loc>https://app.example.com/docs/intro</loc></sitemap>
		</sitemapindex>`,
		"application/xml",
	);
});
try {
	const urls = await discoverSitemaps(
		"https://app.example.com/",
		["https://app.example.com/sitemap.xml"],
		parsed,
		{
			limit: 2,
			scope: "/",
			accept: () => true,
		},
	);
	assert(urls.includes("https://app.example.com/docs/intro"));
	assert(!malformedIndexFetches.includes("https://app.example.com/route"));
} finally {
	setFetchTransportForTest(undefined);
}

let sitemapActive = 0;
let sitemapPeak = 0;
setFetchTransportForTest(async (input) => {
	const url = String(input);
	if (url.endsWith("/sitemap.xml")) {
		const children = Array.from(
			{ length: 8 },
			(_, index) =>
				`<sitemap><loc>https://rate.example/sitemaps/part-${index + 1}.xml</loc></sitemap>`,
		).join("");
		return response(url, 200, `<sitemapindex>${children}</sitemapindex>`);
	}
	if (/\/part-\d+\.xml$/.test(url)) {
		sitemapActive++;
		sitemapPeak = Math.max(sitemapPeak, sitemapActive);
		await Bun.sleep(20);
		sitemapActive--;
		return response(url, 200, "<urlset></urlset>", "application/xml");
	}
	return response(url, 200, "<urlset></urlset>", "application/xml");
});
try {
	await discoverSitemaps(
		"https://rate.example/docs/",
		["https://rate.example/sitemap.xml"],
		rateLimitedConfig,
		{
			limit: 20,
			scope: "/docs/",
			accept: () => false,
		},
	);
	assert(sitemapPeak <= rateLimitedConfig.perOrigin);
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

// allowed seed whose robots both Disallows a path and declares it as a Sitemap:
// declaring a sitemap must not override the Disallow on the normal discovery
// path, so the robots-disallowed sitemap resource is never fetched.
const declaredBypassConfig = parseArgs([
	"https://declbypass.example/public/",
	"-m",
	"6",
]);
assert(
	!("help" in declaredBypassConfig) && !("version" in declaredBypassConfig),
);
const declaredBypassFetches: string[] = [];
setFetchTransportForTest(async (input) => {
	const url = String(input);
	declaredBypassFetches.push(url);
	if (url === "https://declbypass.example/robots.txt") {
		return response(
			url,
			200,
			[
				"User-agent: *",
				"Disallow: /",
				"Allow: /public/",
				"Sitemap: https://declbypass.example/secret-sitemap.xml",
			].join("\n"),
			"text/plain",
		);
	}
	if (url === "https://declbypass.example/secret-sitemap.xml") {
		throw new Error("robots-disallowed declared sitemap fetched");
	}
	if (url === "https://declbypass.example/public/") {
		return response(
			url,
			200,
			`<html><body><main><h1>Public</h1><p>Readable public docs.</p><a href="/public/page">More</a></main></body></html>`,
		);
	}
	if (url === "https://declbypass.example/public/page") {
		return response(
			url,
			200,
			"<html><body><main><h1>Page</h1><p>Another readable public page.</p></main></body></html>",
		);
	}
	return response(url, 404, "not found", "text/plain");
});
try {
	const urls = await discover(declaredBypassConfig);
	assert(
		urls.some((item) => item.url === "https://declbypass.example/public/"),
	);
	assert(!urls.some((item) => item.url.includes("/secret")));
	assert(
		!declaredBypassFetches.includes(
			"https://declbypass.example/secret-sitemap.xml",
		),
	);
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
