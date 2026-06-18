import { afterEach, describe, expect, test } from "bun:test";
import { buildPipelineConfig, parseArgs } from "../src/cli/args.ts";
import { parseFeedEntries } from "../src/discover/feed.ts";
import { discover } from "../src/discover/index.ts";
import {
	normalizeDiscoveryResourceUrl,
	normalizeUrl,
} from "../src/discover/url.ts";
import { setFetchTransportForTest } from "../src/fetch/fetcher.ts";

function config(args: string[]) {
	const parsed = parseArgs(args);
	if ("help" in parsed || "version" in parsed) {
		throw new Error("parseArgs returned help/version");
	}
	return buildPipelineConfig(parsed.run);
}

describe("feed URL normalization", () => {
	test("preserves query-string discovery resource URLs", () => {
		expect(
			normalizeDiscoveryResourceUrl("https://docs.example.com/?feed=rss2"),
		).toBe("https://docs.example.com/?feed=rss2");
	});

	test.each([
		["https://blog.example.com/changelog/feed/"],
		["https://blog.example.com/rss"],
	])("treats extensionless feed endpoints as discovery resources: %s", (url) => {
		expect(normalizeUrl(url)).toBeUndefined();
	});

	test("keeps page URLs that merely include feed in the slug", () => {
		expect(normalizeUrl("https://docs.example.com/docs/feed-api")).toBe(
			"https://docs.example.com/docs/feed-api",
		);
	});
});

describe("feed parsing", () => {
	test("ignores malformed feed entries", () => {
		expect(
			parseFeedEntries(
				"<rss><channel><item><link>",
				"https://docs.example.com/",
			).length,
		).toBe(0);
	});
});

describe("feed discovery", () => {
	afterEach(() => {
		setFetchTransportForTest(undefined);
	});

	test("checks robots before fetching a feed seed", async () => {
		const feedSeedBlockedConfig = config([
			"https://blogblocked.example/feed.xml",
			"-m",
			"2",
		]);
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

		const urls = await discover(feedSeedBlockedConfig);
		expect(feedSeedBlockedFetches[0]).toBe(
			"https://blogblocked.example/robots.txt",
		);
		// robots-allowed llms probes may follow, but never the disallowed seed
		expect(
			feedSeedBlockedFetches.every(
				(url) => url.endsWith("/robots.txt") || url.endsWith("/llms.txt"),
			),
		).toBe(true);
		expect(urls).toHaveLength(1);
		expect(urls[0]?.url).toBe("https://blogblocked.example/feed.xml");
		expect(urls[0]?.source).toBe("seed");
		expect(urls[0]?.fetched?.ok).toBe(false);
		expect(urls[0]?.fetched?.error).toBe("blocked by robots.txt");
	});

	test("sorts RSS feed items by publish date and strips tracking params", async () => {
		const rssFeedConfig = config([
			"https://blog.example.com/feed.xml",
			"-m",
			"2",
		]);
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

		const urls = await discover(rssFeedConfig);
		expect(urls).toHaveLength(2);
		expect(urls[0]?.url).toBe("https://blog.example.com/new");
		expect(urls[1]?.url).toBe("https://blog.example.com/old");
		expect(urls.every((item) => item.source === "feed")).toBe(true);
		expect(urls[0]?.metadata?.publishedAt).toBe("2024-01-02T00:00:00.000Z");
	});

	test("discovers Atom alternates and keeps published and updated metadata", async () => {
		const atomAlternateConfig = config([
			"https://atom.example.com/changelog/",
			"-m",
			"3",
		]);
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

		const urls = await discover(atomAlternateConfig);
		const entry = urls.find((item) => item.url.endsWith("/changelog/entry"));
		expect(entry?.source).toBe("feed");
		if (entry?.source !== "feed") {
			throw new Error("expected feed entry");
		}
		expect(entry.metadata?.publishedAt).toBe("2024-03-03T10:00:00.000Z");
		expect(entry.metadata?.updatedAt).toBe("2024-03-04T10:00:00.000Z");
	});

	test("does not fetch robots-disallowed alternate feeds", async () => {
		const blockedAlternateFeedConfig = config([
			"https://feedgate.example/blog/",
			"-m",
			"3",
		]);
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

		const urls = await discover(blockedAlternateFeedConfig);
		expect(blockedAlternateFetches[0]).toBe(
			"https://feedgate.example/robots.txt",
		);
		expect(blockedAlternateFetches).not.toContain(
			"https://feedgate.example/feed.atom",
		);
		expect(
			blockedAlternateFetches.some((url) => url.endsWith("/llms.txt")),
		).toBe(false);
		expect(
			urls.some((item) => item.url === "https://feedgate.example/blog/post"),
		).toBe(true);
		expect(urls.some((item) => item.source === "feed")).toBe(false);
	});

	test("checks cross-origin robots before fetching alternate feeds", async () => {
		const crossOriginBlockedAlternateFeedConfig = config([
			"https://blog.example.com/",
			"-m",
			"3",
		]);
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

		const urls = await discover(crossOriginBlockedAlternateFeedConfig);
		expect(crossOriginBlockedFetches).toContain(
			"https://feeds.partner.example/robots.txt",
		);
		expect(crossOriginBlockedFetches).not.toContain(
			"https://feeds.partner.example/blog.xml",
		);
		expect(urls.some((item) => item.source === "feed")).toBe(false);
	});

	test("fetches cross-origin alternate feeds when robots allows them", async () => {
		const crossOriginAllowedAlternateFeedConfig = config([
			"https://blog.example.com/",
			"-m",
			"3",
		]);
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

		const urls = await discover(crossOriginAllowedAlternateFeedConfig);
		expect(crossOriginAllowedFetches).toContain(
			"https://feeds.partner.example/robots.txt",
		);
		expect(crossOriginAllowedFetches).toContain(
			"https://feeds.partner.example/blog.xml",
		);
		expect(
			urls.some(
				(item) =>
					item.url === "https://blog.example.com/from-feed" &&
					item.source === "feed",
			),
		).toBe(true);
	});

	test("keeps same-origin feed entries inside scope", async () => {
		const crossOriginFeedConfig = config([
			"https://scope.example.com/feed.xml",
			"-m",
			"3",
		]);
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

		const urls = await discover(crossOriginFeedConfig);
		expect(urls).toHaveLength(1);
		expect(urls[0]?.url).toBe("https://scope.example.com/post");
	});

	test("skips feed discovery when sitemap already fills the result set", async () => {
		let richFeedFetches = 0;
		const richSitemapConfig = config([
			"https://rich.example.com/blog/",
			"-m",
			"6",
		]);
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

		const urls = await discover(richSitemapConfig);
		expect(richFeedFetches).toBe(0);
		expect(urls.every((item) => item.source !== "feed")).toBe(true);
		expect(urls.some((item) => item.source === "sitemap")).toBe(true);
	});
});

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
