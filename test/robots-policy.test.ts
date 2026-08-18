import { describe, expect, test } from "bun:test";
import { startDiscovery } from "../src/discover/index.ts";
import {
	loadRobots,
	maxRobotsBytes,
	robotsFromFetch,
} from "../src/discover/robots.ts";
import { setTestEnv, testConfig } from "./fixtures.ts";

const origin = "https://docs.example.com";

describe("robots fetch policy", () => {
	test.each([
		{
			budget: "dedicated",
			maxBytes: maxRobotsBytes * 2,
			bodyBytes: maxRobotsBytes + 1,
		},
		{ budget: "configured", maxBytes: 1_024, bodyBytes: 1_025 },
	])("fails closed above the $budget byte budget", async ({
		maxBytes,
		bodyBytes,
	}) => {
		const server = Bun.serve({
			port: 0,
			fetch: () => new Response("x".repeat(bodyBytes)),
		});
		const localOrigin = `http://127.0.0.1:${server.port}`;
		setTestEnv("DOCSNAP_ALLOW_TEST_HOST", localOrigin);
		try {
			const robots = await loadRobots(
				localOrigin,
				testConfig("unused", {
					seedUrl: `${localOrigin}/`,
					maxBytes,
				}),
			);
			expect(robots.allowed(`${localOrigin}/page`)).toBe(false);
		} finally {
			server.stop(true);
		}
	});

	test("treats 4xx as open", () => {
		const robots = robotsFromFetch(
			{ ok: false, status: 404, body: "" },
			origin,
		);
		expect(robots.allowed(`${origin}/private`)).toBe(true);
	});

	test("treats 5xx and network failures as closed", () => {
		for (const status of [503, 0]) {
			const robots = robotsFromFetch({ ok: false, status, body: "" }, origin);
			expect(robots.allowed(`${origin}/guide`)).toBe(false);
		}
	});

	test("captures explicit page and site seeds without crawling blocked links", async () => {
		let childHits = 0;
		const server = Bun.serve({
			port: 0,
			fetch(request) {
				const path = new URL(request.url).pathname;
				if (path === "/robots.txt") {
					return new Response("User-agent: *\nDisallow: /\n");
				}
				if (path === "/child") childHits++;
				return new Response(
					'<main>Explicit seed</main><a href="/child">Child</a>',
					{
						headers: { "content-type": "text/html" },
					},
				);
			},
		});
		const localOrigin = `http://127.0.0.1:${server.port}`;
		setTestEnv("DOCSNAP_ALLOW_TEST_HOST", localOrigin);
		try {
			for (const pageOnly of [true, false]) {
				const session = await startDiscovery(
					testConfig("unused", {
						seedUrl: `${localOrigin}/guide`,
						pageOnly,
						max: 2,
						maxExplicit: true,
					}),
				);
				const seed = await session.frontier.take(2);
				expect(seed).toHaveLength(1);
				expect(seed[0]).toMatchObject({
					url: `${localOrigin}/guide`,
					wasSeed: true,
					fetched: { ok: true },
				});
				expect(await session.frontier.take(2)).toEqual([]);
			}
			expect(childHits).toBe(0);
		} finally {
			server.stop(true);
		}
	});

	test.each([
		{
			path: "/feed.xml",
			contentType: "application/rss+xml",
			body: `<?xml version="1.0"?><rss><channel><item><link>/allowed</link></item><item><link>/blocked</link></item></channel></rss>`,
			source: "feed",
		},
		{
			path: "/llms.txt",
			contentType: "text/markdown",
			body: "# Docs\n\n- [Allowed](/allowed)\n- [Blocked](/blocked)",
			source: "llms",
		},
	] as const)("parses an explicit $source resource while filtering listed pages through robots", async ({
		path,
		contentType,
		body,
		source,
	}) => {
		const server = Bun.serve({
			port: 0,
			fetch(request) {
				const requested = new URL(request.url).pathname;
				if (requested === "/robots.txt") {
					return new Response(
						`User-agent: *\nDisallow: ${path}\nDisallow: /blocked\n`,
					);
				}
				if (requested === path) {
					return new Response(body, {
						headers: { "content-type": contentType },
					});
				}
				return new Response("page");
			},
		});
		const localOrigin = `http://127.0.0.1:${server.port}`;
		setTestEnv("DOCSNAP_ALLOW_TEST_HOST", localOrigin);
		try {
			const session = await startDiscovery(
				testConfig("unused", {
					seedUrl: `${localOrigin}${path}`,
					pageOnly: false,
					max: 2,
					maxExplicit: true,
				}),
			);
			expect(await session.frontier.take(2)).toEqual([
				expect.objectContaining({
					url: `${localOrigin}/allowed`,
					source,
				}),
			]);
		} finally {
			server.stop(true);
		}
	});
});
