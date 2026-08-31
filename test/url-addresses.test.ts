import { describe, expect, test } from "bun:test";
import {
	artifactUrl,
	candidateKey,
	identityKeys,
} from "../src/core/identity.ts";
import { normalizeUrl, pathAllowed } from "../src/discover/url.ts";
import {
	validatePublicHttpUrl,
	validateResolvedAddresses,
} from "../src/security/url.ts";
import { testConfig } from "./fixtures.ts";

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

test("filters URL paths with exclude taking precedence", () => {
	const config = testConfig("unused", {
		include: ["/docs/**"],
		exclude: ["/docs/internal/**"],
	});
	expect(pathAllowed("https://example.com/docs", config)).toBeTrue();
	expect(pathAllowed("https://example.com/docs/guide", config)).toBeTrue();
	expect(pathAllowed("https://example.com/docs/internal", config)).toBeFalse();
	expect(pathAllowed("https://example.com/blog", config)).toBeFalse();
});
