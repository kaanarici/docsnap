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

	test("normalizes percent-encoded octets without treating encoded separators as slashes", () => {
		const robots = parseRobots(
			[
				"User-agent: *",
				"Disallow: /private",
				"Disallow: /item/a%2Fb",
				"Disallow: /caf%C3%A9",
			].join("\n"),
			origin,
		);
		expect(robots.allowed(`${origin}/pr%69vate`)).toBe(false);
		expect(robots.allowed(`${origin}/item/a%2fb`)).toBe(false);
		expect(robots.allowed(`${origin}/item/a/b`)).toBe(true);
		expect(robots.allowed(`${origin}/caf%C3%A9`)).toBe(false);
	});

	test.each([
		[
			"rule budget",
			[
				"User-agent: *",
				...Array.from({ length: 6_000 }, (_, i) => `Disallow: /${i}`),
			].join("\n"),
		],
		[
			"line budget",
			`${"#\n".repeat(100_000)}User-agent: *\nDisallow: /private\n`,
		],
		[
			"user-agent budget",
			[
				...Array.from({ length: 1_000 }, (_, i) => `User-agent: bot-${i}`),
				"User-agent: docsnap",
				"Disallow: /private",
			].join("\n"),
		],
	])("fails closed above the %s", (_, body) => {
		const robots = parseRobots(body, origin);
		expect(robots.allowed(`${origin}/otherwise-public`)).toBe(false);
	});
});
