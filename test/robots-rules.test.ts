import { describe, expect, test } from "bun:test";
import { parseRobots } from "../src/discover/robots.ts";

const origin = "https://docs.example.com";

describe("robots rules", () => {
	test("uses the most specific matching user-agent groups", () => {
		const robots = parseRobots(
			[
				"User-agent: *",
				"Disallow: /public",
				"User-agent: docsnap",
				"Disallow: /private",
				"User-agent: docsnap",
				"Allow: /private/open",
			].join("\n"),
			origin,
			"docsnap/0.2",
		);
		expect(robots.allowed(`${origin}/public`)).toBe(true);
		expect(robots.allowed(`${origin}/private/closed`)).toBe(false);
		expect(robots.allowed(`${origin}/private/open`)).toBe(true);
	});

	test("supports wildcards and end anchors", () => {
		const robots = parseRobots("User-agent: *\nDisallow: /*.pdf$\n", origin);
		expect(robots.allowed(`${origin}/guide.pdf`)).toBe(false);
		expect(robots.allowed(`${origin}/guide.pdf?download=1`)).toBe(true);
		expect(robots.allowed(`${origin}/guide.pdf.html`)).toBe(true);
	});

	test("lets allow win an equal-specificity tie", () => {
		const robots = parseRobots(
			"User-agent: *\nDisallow: /same\nAllow: /same\n",
			origin,
		);
		expect(robots.allowed(`${origin}/same`)).toBe(true);
	});
});
