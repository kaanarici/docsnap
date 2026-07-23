import { describe, expect, test } from "bun:test";
import { validatePublicHttpUrl } from "../src/security/url.ts";

describe("public URL syntax", () => {
	test.each([
		"file:///etc/passwd",
		"ftp://example.com/file",
		"data:text/plain,x",
	])("rejects unsupported scheme: %s", (url) =>
		expect(validatePublicHttpUrl(url)).toContain("http"));

	test("rejects credentials", () => {
		expect(
			validatePublicHttpUrl("https://user:secret@example.com/docs"),
		).toContain("credentials");
	});

	test.each([
		"http://localhost",
		"http://localhost.",
		"http://api.localhost",
		"http://api.localhost.",
	])("rejects localhost form: %s", (url) => {
		expect(validatePublicHttpUrl(url)).toContain("localhost");
	});

	test.each([
		"https://intranet",
		"https://printer",
	])("rejects single-label host: %s", (url) =>
		expect(validatePublicHttpUrl(url)).toContain("single-label"));

	test("accepts a normal public URL", () => {
		expect(
			validatePublicHttpUrl("https://docs.example.com/guide"),
		).toBeUndefined();
	});
});
