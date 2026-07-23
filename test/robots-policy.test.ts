import { describe, expect, test } from "bun:test";
import { robotsFromFetch } from "../src/discover/robots.ts";

const origin = "https://docs.example.com";

describe("robots fetch policy", () => {
	test("treats 4xx as open", () => {
		const robots = robotsFromFetch(
			{ ok: false, status: 404, body: "" },
			origin,
		);
		expect(robots.allowed(`${origin}/private`)).toBe(true);
	});

	test("treats 5xx and network failures as closed", () => {
		const serverFailure = robotsFromFetch(
			{ ok: false, status: 503, body: "" },
			origin,
		);
		const networkFailure = robotsFromFetch(
			{ ok: false, status: 0, body: "" },
			origin,
		);
		expect(serverFailure.allowed(`${origin}/guide`)).toBe(false);
		expect(serverFailure.unreachable).toBe(false);
		expect(networkFailure.allowed(`${origin}/guide`)).toBe(false);
		expect(networkFailure.unreachable).toBe(true);
	});
});
