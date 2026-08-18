import { describe, expect, onTestFinished, test } from "bun:test";
import { createDiscoveryFrontier } from "../src/discover/frontier.ts";
import { parseRobots } from "../src/discover/robots.ts";
import { discoverSitemaps } from "../src/discover/sitemap.ts";
import { okFetch, setTestEnv, testConfig } from "./fixtures.ts";

const origin = "https://docs.example.com";

function frontier(links: string[], attemptLimit = 4, truncated = false) {
	const seed = `${origin}/guide`;
	const seedResponse = okFetch(seed, "<main>Guide</main>");
	return createDiscoveryFrontier({
		config: testConfig("unused", {
			seedUrl: seed,
			pageOnly: false,
			max: attemptLimit,
			maxExplicit: true,
		}),
		attemptLimit,
		inputSeed: seed,
		seed,
		scope: "/",
		robots: parseRobots("User-agent: *\nDisallow: /private", origin),
		allowResource: async () => true,
		llmsOptions: { cache: new Map() },
		seedResponse,
		seedResources: { links, nav: [], media: [], truncated },
		seedIsLanguageSelector: false,
		finalSeed: seed,
	});
}

async function drain(discovery: ReturnType<typeof frontier>, batchSize = 10) {
	const urls = [];
	for (;;) {
		const batch = await discovery.take(batchSize);
		if (batch.length === 0) return urls;
		urls.push(...batch);
	}
}

describe("discovery frontier", () => {
	test("keeps Markdown traversal complete with provenance and URL safety", async () => {
		const discovery = frontier([], 2);
		expect((await discovery.take(1))[0]).toMatchObject({
			url: `${origin}/guide`,
			source: "seed",
			wasSeed: true,
		});

		discovery.observe(
			okFetch(
				`${origin}/guide`,
				"# Guide\n\n[Install](/install) [Private](/private) [External](https://other.example/page)",
				{ contentType: "text/markdown" },
			),
		);

		expect(await discovery.take(2)).toEqual([
			expect.objectContaining({ url: `${origin}/install`, source: "crawl" }),
		]);
	});

	test("reports source truncation and enforces the attempt cap", async () => {
		const discovery = frontier(
			["/one", "/two", "/three", "/four"].map((path) => `${origin}${path}`),
			3,
			true,
		);
		const discovered = await drain(discovery);

		expect(discovered.map(({ url }) => url)).toEqual([
			`${origin}/guide`,
			`${origin}/one`,
			`${origin}/two`,
		]);
		expect(discovery.truncated).toBe(true);
	});

	test("searches late index children and keeps numeric part priority", async () => {
		const server = Bun.serve({
			port: 0,
			hostname: "127.0.0.1",
			fetch(request) {
				const url = new URL(request.url);
				const xml = (body: string) =>
					new Response(body, {
						headers: { "content-type": "application/xml" },
					});
				if (url.pathname === "/late.xml") {
					const children = "abcdefghijklm"
						.split("")
						.map(
							(part) =>
								`<sitemap><loc>${url.origin}/sitemap-${part}.xml</loc></sitemap>`,
						)
						.join("");
					return xml(`<sitemapindex>${children}</sitemapindex>`);
				}
				if (url.pathname === "/sitemap-m.xml")
					return xml(
						`<urlset><url><loc>${url.origin}/late-page</loc></url></urlset>`,
					);
				if (/^\/sitemap-[a-l]\.xml$/.test(url.pathname))
					return xml("<urlset/>");
				if (url.pathname === "/parts.xml")
					return xml(
						`<sitemapindex><sitemap><loc>${url.origin}/sitemap-1.xml</loc></sitemap><sitemap><loc>${url.origin}/sitemap-10.xml</loc></sitemap></sitemapindex>`,
					);
				const part = url.pathname.match(/^\/sitemap-(1|10)\.xml$/)?.[1];
				if (part)
					return xml(
						`<urlset><url><loc>${url.origin}/part-${part}</loc></url></urlset>`,
					);
				return new Response("not found", { status: 404 });
			},
		});
		onTestFinished(() => server.stop(true));
		const localOrigin = server.url.origin;
		setTestEnv("DOCSNAP_ALLOW_TEST_HOST", localOrigin);
		const config = testConfig("unused", {
			seedUrl: `${localOrigin}/guide`,
			pageOnly: false,
			concurrency: 4,
			perOrigin: 4,
		});

		const late = await discoverSitemaps(
			config.seedUrl,
			[`${localOrigin}/late.xml`],
			config,
			{ limit: 1, scope: "/" },
		);
		expect(late.urls).toEqual([`${localOrigin}/late-page`]);

		const numeric = await discoverSitemaps(
			config.seedUrl,
			[`${localOrigin}/parts.xml`],
			config,
			{ limit: 1, scope: "/" },
		);
		expect(numeric.urls).toEqual([`${localOrigin}/part-10`]);
	});
});
