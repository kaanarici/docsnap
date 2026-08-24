import { describe, expect, test } from "bun:test";
import {
	artifactUrl,
	candidateKey,
	identityKeys,
} from "../src/core/identity.ts";
import {
	classifyDiscoveryResource,
	relatedHost,
	sameSharedHostPlatform,
	scopeFromFeedResource,
} from "../src/core/url.ts";
import { discoverFeed } from "../src/discover/feed.ts";
import { normalizeUrl } from "../src/discover/url.ts";
import {
	validatePublicHttpUrl,
	validateResolvedAddresses,
} from "../src/security/url.ts";
import { okFetch, testConfig } from "./fixtures.ts";

describe("IP address rejection", () => {
	test.each([
		"0.0.0.0",
		"10.0.0.1",
		"100.64.0.1",
		"127.0.0.1",
		"169.254.1.1",
		"172.16.0.1",
		"192.0.0.1",
		"192.0.2.1",
		"192.168.1.1",
		"198.18.0.1",
		"198.51.100.1",
		"203.0.113.1",
		"224.0.0.1",
	])("rejects blocked IPv4 range: %s", (address) => {
		expect(validatePublicHttpUrl(`http://${address}/`)).toContain("private");
	});

	test.each([
		"::",
		"::1",
		"fc00::1",
		"fe80::1",
		"2001:db8::1",
		"2001:10::1",
		"2001:20::1",
		"2002::1",
		"3fff::1",
		"::ffff:127.0.0.1",
	])("rejects blocked IPv6 range: %s", (address) => {
		expect(validatePublicHttpUrl(`http://[${address}]/`)).toContain("private");
	});

	test("accepts public IPv4 and IPv6 addresses", () => {
		expect(validatePublicHttpUrl("https://1.1.1.1/")).toBeUndefined();
		expect(
			validatePublicHttpUrl("https://[2606:4700:4700::1111]/"),
		).toBeUndefined();
	});
});

describe("resolved-address validation", () => {
	test("rejects mixed public and private DNS answers", () => {
		expect(() =>
			validateResolvedAddresses([
				{ address: "1.1.1.1", family: 4 },
				{ address: "127.0.0.1", family: 4 },
			]),
		).toThrow("private");
	});

	test("deduplicates public answers and rejects empty answers", () => {
		expect(
			validateResolvedAddresses([
				{ address: "1.1.1.1", family: 4 },
				{ address: "1.1.1.1", family: 4 },
			]),
		).toEqual([{ address: "1.1.1.1", family: 4 }]);
		expect(() => validateResolvedAddresses([])).toThrow("did not resolve");
	});
});

describe("URL identity", () => {
	test("does not trust unrelated country-domain registrants", () => {
		for (const suffix of ["co.kr", "com.tr"]) {
			expect(relatedHost(`victim.${suffix}`, `attacker.${suffix}`)).toBeFalse();
			expect(
				sameSharedHostPlatform(`victim.${suffix}`, `attacker.${suffix}`),
			).toBeFalse();
		}
	});

	test("collapses route-equivalent index and extension forms", () => {
		const guide = candidateKey("https://example.com/guide");
		for (const url of [
			"https://example.com/guide/",
			"https://example.com/guide.html",
			"https://example.com/guide/index.html",
		]) {
			expect(candidateKey(url)).toBe(guide);
		}
	});

	test("preserves encoded path separators", () => {
		const encoded = new Set(
			identityKeys({ url: "https://example.com/item/a%2Fb" }),
		);
		expect(
			identityKeys({ url: "https://example.com/item/a/b" }).some((key) =>
				encoded.has(key),
			),
		).toBeFalse();
	});

	test("preserves semantic queries and removes tracking parameters", () => {
		expect(normalizeUrl("https://example.com/guide?version=1")).not.toBe(
			normalizeUrl("https://example.com/guide?version=2"),
		);
		expect(
			normalizeUrl(
				"https://example.com/guide?version=1&utm_source=test&fbclid=x",
			),
		).toBe("https://example.com/guide?version=1");
	});

	test("rejects explicit login-return destinations", () => {
		expect(
			normalizeUrl(
				"https://community.example.com/start?post_login_redirect=%2Fdocs",
			),
		).toBeUndefined();
		expect(normalizeUrl("https://docs.example.com/guide?redirect=/next")).toBe(
			"https://docs.example.com/guide?redirect=%2Fnext",
		);
	});

	test("strips userinfo and hash from artifact URLs without applying the SSRF gate", () => {
		expect(artifactUrl("https://user:secret@example.com/guide#section")).toBe(
			"https://example.com/guide",
		);
		expect(artifactUrl("https://example.com/guide?version=1#top")).toBe(
			"https://example.com/guide?version=1",
		);
		expect(artifactUrl("https://example.com/guide?utm_source=x")).toBe(
			"https://example.com/guide?utm_source=x",
		);
		expect(artifactUrl("http://127.0.0.1/guide")).toBe(
			"http://127.0.0.1/guide",
		);
		expect(validatePublicHttpUrl("http://127.0.0.1/guide")).toContain(
			"private",
		);
		expect(artifactUrl("file:///etc/passwd")).toBeUndefined();
		expect(artifactUrl("not a url")).toBeUndefined();
	});
});

test.each([
	["https://daringfireball.net/feeds/main", "/"],
	["https://planetpython.org/rss20.xml", "/"],
	["https://example.com/blog/rss.xml", "/blog/"],
	["https://example.com/blog/rss", "/blog/"],
	["https://example.com/headlines/rss", "/headlines/"],
])("derives content scope from feed resource %s", (url, scope) => {
	expect(classifyDiscoveryResource(url)?.source).toBe("feed");
	expect(scopeFromFeedResource(url)).toBe(scope);
});

test("widens only an empty feed path scope without crossing origins", async () => {
	const seed = "https://example.com/headlines/rss";
	const response = okFetch(
		seed,
		`<rss><channel>
			<item><link>https://example.com/Articles/1/</link></item>
			<item><link>https://outside.example/Articles/2/</link></item>
		</channel></rss>`,
		{ contentType: "application/rss+xml" },
	);
	const found = await discoverFeed(
		seed,
		seed,
		scopeFromFeedResource(seed),
		testConfig("unused"),
		{ response },
	);
	expect(found.pages.map((page) => page.url)).toEqual([
		"https://example.com/Articles/1/",
	]);

	const blogSeed = "https://example.com/blog/rss";
	const blog = await discoverFeed(
		blogSeed,
		blogSeed,
		scopeFromFeedResource(blogSeed),
		testConfig("unused"),
		{
			response: okFetch(
				blogSeed,
				"<rss><channel><item><link>https://example.com/blog/1</link></item><item><link>https://example.com/elsewhere/2</link></item></channel></rss>",
				{ contentType: "application/rss+xml" },
			),
		},
	);
	expect(blog.pages.map((page) => page.url)).toEqual([
		"https://example.com/blog/1",
	]);
});

test("reads namespaced RDF feeds", async () => {
	const seed = "https://example.com/feed.rdf";
	const response = okFetch(
		seed,
		`<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns="http://purl.org/rss/1.0/"><item><link>https://example.com/guide</link></item></rdf:RDF>`,
		{ contentType: "application/rss+xml" },
	);
	const found = await discoverFeed(seed, seed, "/", testConfig("unused"), {
		response,
	});
	expect(found.pages.map((page) => page.url)).toEqual([
		"https://example.com/guide",
	]);
});
