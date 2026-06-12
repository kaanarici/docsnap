import { parseArgs } from "../src/cli/args.ts";
import { parseFeedEntries } from "../src/discover/feed.ts";
import { discover } from "../src/discover/index.ts";
import {
	normalizeDiscoveryResourceUrl,
	normalizeUrl,
} from "../src/discover/url.ts";
import { setFetchTransportForTest } from "../src/fetch/fetcher.ts";

assert(
	normalizeDiscoveryResourceUrl("https://docs.example.com/?feed=rss2") ===
		"https://docs.example.com/?feed=rss2",
);
// extensionless feed endpoints are discovery resources, never captured pages
assert(normalizeUrl("https://blog.example.com/changelog/feed/") === undefined);
assert(normalizeUrl("https://blog.example.com/rss") === undefined);
assert(
	normalizeUrl("https://docs.example.com/docs/feed-api") ===
		"https://docs.example.com/docs/feed-api",
);
assert(
	parseFeedEntries("<rss><channel><item><link>", "https://docs.example.com/")
		.length === 0,
);

const feedSeedBlockedConfig = parseArgs([
	"https://blogblocked.example/feed.xml",
	"-m",
	"2",
]);
assert(
	!("help" in feedSeedBlockedConfig) && !("version" in feedSeedBlockedConfig),
);
const feedSeedBlockedFetches: string[] = [];
setFetchTransportForTest(async (input) => {
	const url = String(input);
	feedSeedBlockedFetches.push(url);
	if (url === "https://blogblocked.example/robots.txt") {
		return response(
			url,
			200,
			"User-agent: *\nDisallow: /feed.xml",
			"text/plain",
		);
	}
	if (url === "https://blogblocked.example/feed.xml") {
		throw new Error("feed seed fetched before robots gate");
	}
	return response(url, 404, "not found", "text/plain");
});
try {
	const urls = await discover(feedSeedBlockedConfig);
	assert(feedSeedBlockedFetches.length === 1);
	assert(
		feedSeedBlockedFetches[0] === "https://blogblocked.example/robots.txt",
	);
	assert(urls.length === 1);
	assert(urls[0]?.url === "https://blogblocked.example/feed.xml");
	assert(urls[0]?.source === "seed");
	assert(urls[0]?.fetched?.ok === false);
	assert(urls[0]?.fetched?.error === "blocked by robots.txt");
} finally {
	setFetchTransportForTest(undefined);
}

const rssFeedConfig = parseArgs([
	"https://blog.example.com/feed.xml",
	"-m",
	"2",
]);
assert(!("help" in rssFeedConfig) && !("version" in rssFeedConfig));
setFetchTransportForTest(async (input) => {
	const url = String(input);
	if (url.endsWith("/llms.txt") || url.endsWith("/robots.txt"))
		return response(url, 404, "not found", "text/plain");
	if (url === "https://blog.example.com/feed.xml") {
		return response(
			url,
			200,
			`<rss version="2.0"><channel>
				<item><title>Old</title><link>https://blog.example.com/old</link><pubDate>Mon, 01 Jan 2024 00:00:00 GMT</pubDate></item>
				<item><title>New</title><link>https://blog.example.com/new?utm=feed</link><pubDate>Tue, 02 Jan 2024 00:00:00 GMT</pubDate></item>
			</channel></rss>`,
			"application/rss+xml",
		);
	}
	return response(url, 404, "not found", "text/plain");
});
try {
	const urls = await discover(rssFeedConfig);
	assert(urls.length === 2);
	assert(urls[0]?.url === "https://blog.example.com/new");
	assert(urls[1]?.url === "https://blog.example.com/old");
	assert(urls.every((item) => item.source === "feed"));
	assert(urls[0]?.metadata?.publishedAt === "2024-01-02T00:00:00.000Z");
} finally {
	setFetchTransportForTest(undefined);
}

const atomAlternateConfig = parseArgs([
	"https://atom.example.com/changelog/",
	"-m",
	"3",
]);
assert(!("help" in atomAlternateConfig) && !("version" in atomAlternateConfig));
setFetchTransportForTest(async (input) => {
	const url = String(input);
	if (url.endsWith("/llms.txt") || url.endsWith("/robots.txt"))
		return response(url, 404, "not found", "text/plain");
	if (url === "https://atom.example.com/changelog/") {
		return response(
			url,
			200,
			`<html><head><link rel="alternate" type="application/atom+xml" href="/feed.atom"></head><body><main>Changelog</main></body></html>`,
		);
	}
	if (url === "https://atom.example.com/feed.atom") {
		return response(
			url,
			200,
			`<feed xmlns="http://www.w3.org/2005/Atom">
				<entry><title>Entry</title><link href="/changelog/entry"/><published>2024-03-03T10:00:00Z</published><updated>2024-03-04T10:00:00Z</updated></entry>
			</feed>`,
			"application/atom+xml",
		);
	}
	return response(url, 404, "not found", "text/plain");
});
try {
	const urls = await discover(atomAlternateConfig);
	const entry = urls.find((item) => item.url.endsWith("/changelog/entry"));
	assert(entry?.source === "feed");
	assert(entry.metadata?.publishedAt === "2024-03-03T10:00:00.000Z");
	assert(entry.metadata?.updatedAt === "2024-03-04T10:00:00.000Z");
} finally {
	setFetchTransportForTest(undefined);
}

const blockedAlternateFeedConfig = parseArgs([
	"https://feedgate.example/blog/",
	"-m",
	"3",
]);
assert(
	!("help" in blockedAlternateFeedConfig) &&
		!("version" in blockedAlternateFeedConfig),
);
const blockedAlternateFetches: string[] = [];
setFetchTransportForTest(async (input) => {
	const url = String(input);
	blockedAlternateFetches.push(url);
	if (url === "https://feedgate.example/robots.txt") {
		return response(
			url,
			200,
			[
				"User-agent: *",
				"Disallow: /feed.atom",
				"Disallow: /llms.txt",
				"Disallow: /blog/llms.txt",
			].join("\n"),
			"text/plain",
		);
	}
	if (
		url.endsWith("/llms.txt") ||
		url === "https://feedgate.example/feed.atom"
	) {
		throw new Error("robots-disallowed discovery resource fetched");
	}
	if (url === "https://feedgate.example/blog/") {
		return response(
			url,
			200,
			`<html><head><link rel="alternate" type="application/atom+xml" href="/feed.atom"></head><body><main><a href="/blog/post">Post</a></main></body></html>`,
		);
	}
	return response(url, 404, "not found", "text/plain");
});
try {
	const urls = await discover(blockedAlternateFeedConfig);
	assert(blockedAlternateFetches[0] === "https://feedgate.example/robots.txt");
	assert(
		!blockedAlternateFetches.includes("https://feedgate.example/feed.atom"),
	);
	assert(!blockedAlternateFetches.some((url) => url.endsWith("/llms.txt")));
	assert(
		urls.some((item) => item.url === "https://feedgate.example/blog/post"),
	);
	assert(!urls.some((item) => item.source === "feed"));
} finally {
	setFetchTransportForTest(undefined);
}

const crossOriginBlockedAlternateFeedConfig = parseArgs([
	"https://blog.example.com/",
	"-m",
	"3",
]);
assert(
	!("help" in crossOriginBlockedAlternateFeedConfig) &&
		!("version" in crossOriginBlockedAlternateFeedConfig),
);
const crossOriginBlockedFetches: string[] = [];
setFetchTransportForTest(async (input) => {
	const url = String(input);
	crossOriginBlockedFetches.push(url);
	if (url === "https://blog.example.com/robots.txt") {
		return response(url, 404, "not found", "text/plain");
	}
	if (url.endsWith("/llms.txt")) {
		return response(url, 404, "not found", "text/plain");
	}
	if (url === "https://feeds.partner.example/robots.txt") {
		return response(
			url,
			200,
			"User-agent: *\nDisallow: /blog.xml",
			"text/plain",
		);
	}
	if (url === "https://feeds.partner.example/blog.xml") {
		throw new Error("cross-origin robots-disallowed feed fetched");
	}
	if (url === "https://blog.example.com/") {
		return response(
			url,
			200,
			`<html><head><link rel="alternate" type="application/rss+xml" href="https://feeds.partner.example/blog.xml"></head><body><main>Updates</main></body></html>`,
		);
	}
	return response(url, 404, "not found", "text/plain");
});
try {
	const urls = await discover(crossOriginBlockedAlternateFeedConfig);
	assert(
		crossOriginBlockedFetches.includes(
			"https://feeds.partner.example/robots.txt",
		),
	);
	assert(
		!crossOriginBlockedFetches.includes(
			"https://feeds.partner.example/blog.xml",
		),
	);
	assert(!urls.some((item) => item.source === "feed"));
} finally {
	setFetchTransportForTest(undefined);
}

const crossOriginAllowedAlternateFeedConfig = parseArgs([
	"https://blog.example.com/",
	"-m",
	"3",
]);
assert(
	!("help" in crossOriginAllowedAlternateFeedConfig) &&
		!("version" in crossOriginAllowedAlternateFeedConfig),
);
const crossOriginAllowedFetches: string[] = [];
setFetchTransportForTest(async (input) => {
	const url = String(input);
	crossOriginAllowedFetches.push(url);
	if (url === "https://blog.example.com/robots.txt") {
		return response(url, 404, "not found", "text/plain");
	}
	if (url.endsWith("/llms.txt")) {
		return response(url, 404, "not found", "text/plain");
	}
	if (url === "https://feeds.partner.example/robots.txt") {
		return response(url, 404, "not found", "text/plain");
	}
	if (url === "https://feeds.partner.example/blog.xml") {
		return response(
			url,
			200,
			`<rss><channel><item><link>https://blog.example.com/from-feed</link></item></channel></rss>`,
			"application/rss+xml",
		);
	}
	if (url === "https://blog.example.com/") {
		return response(
			url,
			200,
			`<html><head><link rel="alternate" type="application/rss+xml" href="https://feeds.partner.example/blog.xml"></head><body><main>Updates</main></body></html>`,
		);
	}
	return response(url, 404, "not found", "text/plain");
});
try {
	const urls = await discover(crossOriginAllowedAlternateFeedConfig);
	assert(
		crossOriginAllowedFetches.includes(
			"https://feeds.partner.example/robots.txt",
		),
	);
	assert(
		crossOriginAllowedFetches.includes(
			"https://feeds.partner.example/blog.xml",
		),
	);
	assert(
		urls.some(
			(item) =>
				item.url === "https://blog.example.com/from-feed" &&
				item.source === "feed",
		),
	);
} finally {
	setFetchTransportForTest(undefined);
}

const crossOriginFeedConfig = parseArgs([
	"https://scope.example.com/feed.xml",
	"-m",
	"3",
]);
assert(
	!("help" in crossOriginFeedConfig) && !("version" in crossOriginFeedConfig),
);
setFetchTransportForTest(async (input) => {
	const url = String(input);
	if (url.endsWith("/llms.txt") || url.endsWith("/robots.txt"))
		return response(url, 404, "not found", "text/plain");
	if (url === "https://scope.example.com/feed.xml") {
		return response(
			url,
			200,
			`<rss><channel>
				<item><link>https://scope.example.com/post</link></item>
				<item><link>https://other.example.com/post</link></item>
			</channel></rss>`,
			"application/rss+xml",
		);
	}
	return response(url, 404, "not found", "text/plain");
});
try {
	const urls = await discover(crossOriginFeedConfig);
	assert(urls.length === 1);
	assert(urls[0]?.url === "https://scope.example.com/post");
} finally {
	setFetchTransportForTest(undefined);
}

let richFeedFetches = 0;
const richSitemapConfig = parseArgs([
	"https://rich.example.com/blog/",
	"-m",
	"6",
]);
assert(!("help" in richSitemapConfig) && !("version" in richSitemapConfig));
setFetchTransportForTest(async (input) => {
	const url = String(input);
	if (url.endsWith("/llms.txt") || url.endsWith("/robots.txt"))
		return response(url, 404, "not found", "text/plain");
	if (url === "https://rich.example.com/blog/") {
		return response(
			url,
			200,
			`<html><head><link rel="alternate" type="application/rss+xml" href="/feed.xml"></head><body><main>Blog</main></body></html>`,
		);
	}
	if (url === "https://rich.example.com/sitemap.xml") {
		return response(
			url,
			200,
			`<urlset>${Array.from(
				{ length: 5 },
				(_, index) =>
					`<url><loc>https://rich.example.com/blog/post-${index + 1}</loc></url>`,
			).join("")}</urlset>`,
			"application/xml",
		);
	}
	if (url === "https://rich.example.com/feed.xml") richFeedFetches++;
	return response(url, 404, "not found", "text/plain");
});
try {
	const urls = await discover(richSitemapConfig);
	assert(richFeedFetches === 0);
	assert(urls.every((item) => item.source !== "feed"));
	assert(urls.some((item) => item.source === "sitemap"));
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
