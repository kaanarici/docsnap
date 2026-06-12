import { parseArgs } from "../src/cli/args.ts";
import { sameSiteLabel } from "../src/core/url.ts";
import { discover } from "../src/discover/index.ts";
import { setFetchTransportForTest } from "../src/fetch/fetcher.ts";
import { buildSummary } from "../src/report/summary.ts";

const config = parseArgs(["https://docs.example.com/docs/", "-m", "5"]);
assert(!("help" in config) && !("version" in config));
assert(!sameSiteLabel("docs.example.co.uk", "evil.attacker.co.uk"));
assert(!sameSiteLabel("docs.example.com.au", "evil.attacker.com.au"));
assert(sameSiteLabel("docs.stripe.com", "stripe.dev"));

setFetchTransportForTest(async (input) => {
	const url = String(input);
	if (url === "https://docs.example.com/llms.txt") {
		return response(
			url,
			302,
			"",
			"text/plain",
			"https://evil.example/llms.txt",
		);
	}
	if (url === "https://evil.example/llms.txt") {
		return response(
			url,
			200,
			Array.from(
				{ length: 5 },
				(_, index) => `- [Evil ${index}](https://evil.example/${index}.md)`,
			).join("\n"),
			"text/markdown",
		);
	}
	return response(url, 404, "not found", "text/plain");
});
try {
	const discovered = await discover(config);
	assert(
		!discovered.some((item) => item.url.startsWith("https://evil.example/")),
	);
} finally {
	setFetchTransportForTest(undefined);
}

const movedBrandConfig = parseArgs(["https://rspack.dev/guide/", "-m", "6"]);
assert(!("help" in movedBrandConfig) && !("version" in movedBrandConfig));
setFetchTransportForTest(async (input) => {
	const url = String(input);
	if (url === "https://rspack.dev/llms.txt") {
		return response(url, 301, "", "text/plain", "https://rspack.rs/llms.txt");
	}
	if (url === "https://rspack.rs/llms.txt") {
		return response(
			url,
			200,
			Array.from(
				{ length: 5 },
				(_, index) => `- [Guide ${index}](https://rspack.rs/guide/${index}.md)`,
			).join("\n"),
			"text/markdown",
		);
	}
	return response(url, 404, "not found", "text/plain");
});
try {
	const discovered = await discover(movedBrandConfig);
	assert(discovered.some((item) => item.url.startsWith("https://rspack.rs/")));
} finally {
	setFetchTransportForTest(undefined);
}

const readTheDocsConfig = parseArgs([
	"https://foo.readthedocs.io/en/latest/",
	"-m",
	"6",
]);
assert(!("help" in readTheDocsConfig) && !("version" in readTheDocsConfig));
setFetchTransportForTest(async (input) => {
	const url = String(input);
	if (url === "https://foo.readthedocs.io/en/latest/llms.txt") {
		return response(
			url,
			200,
			Array.from(
				{ length: 5 },
				(_, index) =>
					`- [Page ${index}](https://project.readthedocs.io/en/latest/${index}.html)`,
			).join("\n"),
			"text/markdown",
		);
	}
	return response(url, 404, "not found", "text/plain");
});
try {
	const discovered = await discover(readTheDocsConfig);
	assert(
		discovered.some((item) =>
			item.url.startsWith("https://project.readthedocs.io/en/latest/"),
		),
	);
} finally {
	setFetchTransportForTest(undefined);
}

const failedRedirectSummary = buildSummary(
	[
		{
			ok: false,
			url: "https://docs.example.com/start",
			finalUrl: "https://evil.example/prompt",
			redirects: [
				{
					from: "https://docs.example.com/start",
					to: "https://evil.example/prompt",
					type: "http",
					status: 302,
				},
			],
			fetchedAt: "2026-01-01T00:00:00.000Z",
			injectionSignals: [],
			status: 0,
			source: "seed",
			timings: { fetchMs: 1, extractMs: 0, writeMs: 0 },
			markdown: "",
			links: [],
			contentHash: "",
			extractor: "none",
			confidence: 0,
			qualityReasons: [],
			error: "URL credentials are not allowed",
			failureKind: "unsafe_url",
		},
	],
	config,
	1,
	0,
	{ rootHash: "hash", files: 0, bytes: 0 },
	1,
);
assert(failedRedirectSummary.hostRedirects === 0);
assert(failedRedirectSummary.redirectedHosts.length === 0);

const successfulRedirectSummary = buildSummary(
	[
		{
			ok: true,
			url: "https://docs.example.com/start",
			finalUrl: "https://target.example/guide",
			redirects: [
				{
					from: "https://docs.example.com/start",
					to: "https://target.example/guide",
					type: "http",
					status: 302,
				},
			],
			fetchedAt: "2026-01-01T00:00:00.000Z",
			injectionSignals: [],
			status: 200,
			source: "seed",
			timings: { fetchMs: 1, extractMs: 1, writeMs: 0 },
			markdown: "# Guide",
			links: [],
			contentHash: "hash",
			extractor: "html",
			confidence: 1,
			qualityReasons: [],
			outputPath: "guide.md",
		},
	],
	config,
	1,
	0,
	{ rootHash: "hash", files: 1, bytes: 1 },
	1,
);
assert(successfulRedirectSummary.hostRedirects > 0);
assert(
	successfulRedirectSummary.redirectedHosts.some(
		(item) =>
			item.from === "docs.example.com" &&
			item.to === "target.example" &&
			item.count === 1,
	),
);

// llms corpus expansion links must pass the robots gate before being fetched
const llmsExpandConfig = parseArgs(["https://llmsexpand.example/", "-m", "5"]);
assert(!("help" in llmsExpandConfig) && !("version" in llmsExpandConfig));
const llmsExpandFetches: string[] = [];
setFetchTransportForTest(async (input) => {
	const url = String(input);
	llmsExpandFetches.push(url);
	if (url === "https://llmsexpand.example/robots.txt") {
		return response(
			url,
			200,
			"User-agent: *\nDisallow: /private/",
			"text/plain",
		);
	}
	if (url === "https://llmsexpand.example/llms.txt") {
		return response(
			url,
			200,
			"# Corpus\n- [Guide](/docs/guide.md)\n- [Private](/private/index.md)\n- [More](/docs/more.md)\n- [Extra](/docs/extra.md)\n- [Other](/docs/other.md)\n",
			"text/plain",
		);
	}
	if (url === "https://llmsexpand.example/private/index.md") {
		throw new Error("robots-disallowed llms expansion link fetched");
	}
	return response(url, 404, "not found", "text/plain");
});
try {
	const urls = await discover(llmsExpandConfig);
	assert(
		!llmsExpandFetches.includes("https://llmsexpand.example/private/index.md"),
	);
	assert(
		urls.some(
			(item) => item.url === "https://llmsexpand.example/docs/guide.md",
		),
	);
} finally {
	setFetchTransportForTest(undefined);
}

// an allowed llms.txt redirecting to a disallowed URL must not become corpus
const llmsRedirectConfig = parseArgs(["https://llmsredir.example/", "-m", "3"]);
assert(!("help" in llmsRedirectConfig) && !("version" in llmsRedirectConfig));
setFetchTransportForTest(async (input) => {
	const url = String(input);
	if (url === "https://llmsredir.example/robots.txt") {
		return response(
			url,
			200,
			"User-agent: *\nDisallow: /private/",
			"text/plain",
		);
	}
	if (url === "https://llmsredir.example/llms.txt") {
		return response(url, 301, "", "text/plain", "/private/llms.txt");
	}
	if (url === "https://llmsredir.example/private/llms.txt") {
		return response(
			url,
			200,
			"# Secret corpus\n- [Hidden](/private/hidden.md)\n",
			"text/plain",
		);
	}
	if (url === "https://llmsredir.example/") {
		return response(
			url,
			200,
			`<html><body><main><a href="/docs/guide">Guide</a></main></body></html>`,
			"text/html",
		);
	}
	return response(url, 404, "not found", "text/plain");
});
try {
	const urls = await discover(llmsRedirectConfig);
	assert(!urls.some((item) => item.source === "llms"));
	assert(!urls.some((item) => item.url.includes("/private/")));
} finally {
	setFetchTransportForTest(undefined);
}

// a Disallow:/ seed with Allow carve-outs and a declared sitemap must yield
// the allowed subtree without fetching the seed or probing default sitemaps
const carveOutConfig = parseArgs(["https://carveout.example/", "-m", "5"]);
assert(!("help" in carveOutConfig) && !("version" in carveOutConfig));
const carveOutFetches: string[] = [];
setFetchTransportForTest(async (input) => {
	const url = String(input);
	carveOutFetches.push(url);
	if (url === "https://carveout.example/robots.txt") {
		return response(
			url,
			200,
			[
				"User-agent: *",
				"Disallow: /",
				"Allow: /en/stable",
				"Sitemap: https://carveout.example/declared-sitemap.xml",
			].join("\n"),
			"text/plain",
		);
	}
	if (url === "https://carveout.example/declared-sitemap.xml") {
		return response(
			url,
			200,
			`<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
				<url><loc>https://carveout.example/en/stable/intro</loc></url>
				<url><loc>https://carveout.example/en/stable/config</loc></url>
				<url><loc>https://carveout.example/private/admin</loc></url>
			</urlset>`,
			"application/xml",
		);
	}
	if (url === "https://carveout.example/") {
		throw new Error("disallowed seed fetched");
	}
	if (url === "https://carveout.example/sitemap.xml") {
		throw new Error("undeclared sitemap probed despite Disallow:/");
	}
	return response(url, 404, "not found", "text/plain");
});
try {
	const urls = await discover(carveOutConfig);
	assert(
		urls.some(
			(item) => item.url === "https://carveout.example/en/stable/intro",
		),
	);
	assert(
		urls.some(
			(item) => item.url === "https://carveout.example/en/stable/config",
		),
	);
	assert(!urls.some((item) => item.url.includes("/private/")));
	assert(!carveOutFetches.includes("https://carveout.example/"));
	assert(!carveOutFetches.includes("https://carveout.example/sitemap.xml"));
} finally {
	setFetchTransportForTest(undefined);
}

// Disallow:/ with no declared sitemap and no allowed llms: blocked seed only,
// and no sitemap probing at all
const fullyBlockedConfig = parseArgs([
	"https://fullyblocked.example/",
	"-m",
	"3",
]);
assert(!("help" in fullyBlockedConfig) && !("version" in fullyBlockedConfig));
const fullyBlockedFetches: string[] = [];
setFetchTransportForTest(async (input) => {
	const url = String(input);
	fullyBlockedFetches.push(url);
	if (url === "https://fullyblocked.example/robots.txt") {
		return response(url, 200, "User-agent: *\nDisallow: /", "text/plain");
	}
	if (url.includes("sitemap")) {
		throw new Error("sitemap probed on fully blocked origin");
	}
	if (url === "https://fullyblocked.example/") {
		throw new Error("disallowed seed fetched");
	}
	return response(url, 404, "not found", "text/plain");
});
try {
	const urls = await discover(fullyBlockedConfig);
	assert(urls.length === 1);
	assert(urls[0]?.fetched?.ok === false);
	assert(urls[0]?.fetched?.failureKind === "blocked");
	assert(fullyBlockedFetches[0] === "https://fullyblocked.example/robots.txt");
	assert(!fullyBlockedFetches.some((url) => url.includes("sitemap")));
} finally {
	setFetchTransportForTest(undefined);
}

// apex origins that refuse robots.txt but redirect the seed to a related www
// origin must restart discovery there, gated by the www origin's robots
const apexConfig = parseArgs(["https://apex.example/", "-m", "4"]);
assert(!("help" in apexConfig) && !("version" in apexConfig));
const apexFetches: string[] = [];
setFetchTransportForTest(async (input) => {
	const url = String(input);
	apexFetches.push(url);
	if (url === "https://apex.example/robots.txt") {
		throw new Error("connect ECONNREFUSED apex.example:443");
	}
	if (url === "https://apex.example/") {
		return response(url, 301, "", "text/plain", "https://www.apex.example/");
	}
	if (url === "https://www.apex.example/robots.txt") {
		return response(
			url,
			200,
			"User-agent: *\nDisallow: /private/",
			"text/plain",
		);
	}
	if (url === "https://www.apex.example/") {
		return response(
			url,
			200,
			`<html><body><main><a href="/guide">Guide</a><a href="/private/x">No</a></main></body></html>`,
			"text/html",
		);
	}
	if (url === "https://www.apex.example/guide") {
		return response(
			url,
			200,
			"<html><body><main><h1>Guide</h1><p>Readable canonical content here.</p></main></body></html>",
			"text/html",
		);
	}
	return response(url, 404, "not found", "text/plain");
});
try {
	const urls = await discover(apexConfig);
	assert(urls.some((item) => item.url === "https://www.apex.example/guide"));
	assert(!urls.some((item) => item.url.includes("/private/")));
	assert(apexFetches.includes("https://www.apex.example/robots.txt"));
} finally {
	setFetchTransportForTest(undefined);
}

// Disallow:/ with a literal Allow prefix and no sitemap: the prefix is an
// explicit entry invitation — discovery restarts there, never fetching /
const allowPrefixConfig = parseArgs(["https://prefix.example/", "-m", "4"]);
assert(!("help" in allowPrefixConfig) && !("version" in allowPrefixConfig));
const allowPrefixFetches: string[] = [];
setFetchTransportForTest(async (input) => {
	const url = String(input);
	allowPrefixFetches.push(url);
	if (url === "https://prefix.example/robots.txt") {
		return response(
			url,
			200,
			"User-agent: *\nDisallow: /\nAllow: /latest/",
			"text/plain",
		);
	}
	if (url === "https://prefix.example/") {
		throw new Error("disallowed root fetched");
	}
	if (url === "https://prefix.example/latest/") {
		return response(
			url,
			200,
			`<html><body><main><h1>Latest</h1><p>Docs index with real text.</p><a href="/latest/setup">Setup</a></main></body></html>`,
			"text/html",
		);
	}
	if (url === "https://prefix.example/latest/setup") {
		return response(
			url,
			200,
			"<html><body><main><h1>Setup</h1><p>Install and configure things.</p></main></body></html>",
			"text/html",
		);
	}
	return response(url, 404, "not found", "text/plain");
});
try {
	const urls = await discover(allowPrefixConfig);
	assert(urls.some((item) => item.url === "https://prefix.example/latest/"));
	assert(
		urls.some((item) => item.url === "https://prefix.example/latest/setup"),
	);
	assert(!allowPrefixFetches.includes("https://prefix.example/"));
} finally {
	setFetchTransportForTest(undefined);
}

function response(
	url: string,
	status: number,
	body: string,
	contentType: string,
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

function assert(condition: unknown): asserts condition {
	if (!condition) throw new Error("assertion failed");
}
