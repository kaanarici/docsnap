import { describe, expect, test } from "bun:test";
import {
	validatePublicHttpUrl,
	validateResolvedAddresses,
} from "../src/security/url.ts";

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
