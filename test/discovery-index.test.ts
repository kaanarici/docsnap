import { describe, expect, onTestFinished, test } from "bun:test";
import { parseHTML } from "linkedom";
import { startDiscovery } from "../src/discover/index.ts";
import { discoverLlms } from "../src/discover/llms.ts";
import {
	discoverFetchedResources,
	discoverPageResources,
} from "../src/discover/nav.ts";
import { okFetch, setTestEnv, testConfig } from "./fixtures.ts";

function listed(session: Awaited<ReturnType<typeof startDiscovery>>) {
	return drain(session).then((found) =>
		found.map((item) => ({
			path: new URL(item.url).pathname,
			source: item.source,
			wasSeed: item.wasSeed === true,
		})),
	);
}

async function drain(session: Awaited<ReturnType<typeof startDiscovery>>) {
	const urls = [];
	for (;;) {
		const batch = await session.frontier.take(10);
		if (batch.length === 0) return urls;
		urls.push(...batch);
	}
}

function serve(routes: Record<string, { body: string; type?: string }>) {
	const server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		fetch(request) {
			const path = new URL(request.url).pathname;
			const route = routes[path];
			if (!route) return new Response("not found", { status: 404 });
			return new Response(route.body, {
				headers: { "content-type": route.type ?? "text/html" },
			});
		},
	});
	onTestFinished(() => server.stop(true));
	const origin = server.url.origin;
	setTestEnv("DOCSNAP_ALLOW_TEST_HOST", origin);
	return origin;
}

function siteConfig(origin: string, max = 8) {
	return testConfig("unused", {
		seedUrl: `${origin}/`,
		pageOnly: false,
		max,
		maxExplicit: true,
		concurrency: 2,
		perOrigin: 2,
	});
}

describe("discovery index policy", () => {
	test("does not accept one filtered llms URL as a complete root corpus", async () => {
		const origin = serve({
			"/": { body: "<main>Home</main>" },
			"/llms.txt": {
				type: "text/markdown",
				body: "# Docs\n\n- [One](/docs/one)\n",
			},
			"/sitemap.xml": {
				type: "application/xml",
				body: `<urlset>
					<url><loc>/docs/one</loc></url>
					<url><loc>/docs/two</loc></url>
					<url><loc>/docs/three</loc></url>
				</urlset>`,
			},
			"/docs/one": { body: "<main>One</main>" },
			"/docs/two": { body: "<main>Two</main>" },
			"/docs/three": { body: "<main>Three</main>" },
		});
		const config = siteConfig(origin);
		config.include = ["/docs/**"];

		expect(await listed(await startDiscovery(config))).toEqual([
			{ path: "/", source: "seed", wasSeed: true },
			{ path: "/docs/one", source: "sitemap", wasSeed: false },
			{ path: "/docs/two", source: "sitemap", wasSeed: false },
			{ path: "/docs/three", source: "sitemap", wasSeed: false },
		]);
	});

	test("applies path filters before accepting llms.txt candidates", async () => {
		const origin = serve({
			"/": { body: "<main>Home</main>" },
			"/llms.txt": {
				type: "text/markdown",
				body: [
					"# Docs",
					"- [One](/docs/one)",
					"- [Two](/docs/two)",
					"- [Three](/docs/three)",
					"- [Internal](/docs/internal/secret)",
					"- [Blog](/blog/post)",
				].join("\n"),
			},
		});
		const config = siteConfig(origin);
		config.include = ["/docs/**"];
		config.exclude = ["/docs/internal/**"];

		expect(await listed(await startDiscovery(config))).toEqual([
			{ path: "/", source: "seed", wasSeed: true },
			{ path: "/docs/one", source: "llms", wasSeed: false },
			{ path: "/docs/two", source: "llms", wasSeed: false },
			{ path: "/docs/three", source: "llms", wasSeed: false },
		]);
	});

	test("expands a filtered-out section index to reach matching pages", async () => {
		const origin = serve({
			"/": { body: "<main>Home</main>" },
			"/llms.txt": {
				type: "text/markdown",
				body: "# Docs\n\n- [Index](/index.md)",
			},
			"/index.md": {
				type: "text/markdown",
				body: "- [A](/docs/api/a)\n- [B](/docs/api/b)\n- [C](/docs/api/c)",
			},
		});
		const config = siteConfig(origin);
		config.include = ["/docs/api/**"];

		expect(await listed(await startDiscovery(config))).toEqual([
			{ path: "/", source: "seed", wasSeed: true },
			{ path: "/docs/api/a", source: "llms", wasSeed: false },
			{ path: "/docs/api/b", source: "llms", wasSeed: false },
			{ path: "/docs/api/c", source: "llms", wasSeed: false },
		]);
	});

	test("falls back to llms.txt when the seed page itself fails", async () => {
		const origin = serve({
			"/llms.txt": {
				type: "text/markdown",
				body: "# Docs\n\n- [One](/one)\n- [Two](/two)\n- [Three](/three)",
			},
			"/one": { body: "<main>One</main>" },
			"/two": { body: "<main>Two</main>" },
			"/three": { body: "<main>Three</main>" },
		});

		expect(await listed(await startDiscovery(siteConfig(origin)))).toEqual([
			{ path: "/", source: "seed", wasSeed: true },
			{ path: "/one", source: "llms", wasSeed: false },
			{ path: "/two", source: "llms", wasSeed: false },
			{ path: "/three", source: "llms", wasSeed: false },
		]);
	});

	test("keeps the explicit seed and returns an llms.txt corpus without crawling", async () => {
		const origin = serve({
			"/": {
				body: '<main>Home</main><a href="/crawled">Crawled</a>',
			},
			"/llms.txt": {
				type: "text/markdown",
				body: "# Docs\n\n- [One](/one)\n- [Two](/two)\n- [Three](/three)\n",
			},
			"/one": { body: "<main>One</main>" },
			"/two": { body: "<main>Two</main>" },
			"/three": { body: "<main>Three</main>" },
			"/crawled": { body: "<main>Crawled</main>" },
		});

		expect(await listed(await startDiscovery(siteConfig(origin)))).toEqual([
			{ path: "/", source: "seed", wasSeed: true },
			{ path: "/one", source: "llms", wasSeed: false },
			{ path: "/two", source: "llms", wasSeed: false },
			{ path: "/three", source: "llms", wasSeed: false },
		]);
	});

	test("returns a sitemap corpus when llms.txt is absent, without crawling", async () => {
		const origin = serve({
			"/": {
				body: '<main>Home</main><a href="/crawled">Crawled</a>',
			},
			"/sitemap.xml": {
				type: "application/xml",
				body: `<?xml version="1.0"?><urlset>
					<url><loc>/s1</loc></url>
					<url><loc>/s2</loc></url>
					<url><loc>/s3</loc></url>
				</urlset>`,
			},
			"/s1": { body: "<main>S1</main>" },
			"/s2": { body: "<main>S2</main>" },
			"/s3": { body: "<main>S3</main>" },
			"/crawled": { body: "<main>Crawled</main>" },
		});

		expect(await listed(await startDiscovery(siteConfig(origin)))).toEqual([
			{ path: "/", source: "seed", wasSeed: true },
			{ path: "/s1", source: "sitemap", wasSeed: false },
			{ path: "/s2", source: "sitemap", wasSeed: false },
			{ path: "/s3", source: "sitemap", wasSeed: false },
		]);
	});

	test("falls back to crawl when neither llms.txt nor sitemap is a corpus", async () => {
		const origin = serve({
			"/": {
				body: '<main>Home</main><a href="/one">One</a><a href="/two">Two</a>',
			},
			"/one": { body: "<main>One</main>" },
			"/two": { body: "<main>Two</main>" },
		});

		expect(await listed(await startDiscovery(siteConfig(origin)))).toEqual([
			{ path: "/", source: "seed", wasSeed: true },
			{ path: "/one", source: "crawl", wasSeed: false },
			{ path: "/two", source: "crawl", wasSeed: false },
		]);
	});
});

test("reuses a full parsed document for oversized HTML discovery", () => {
	const tail = '<a href="/after-limit">After limit</a>';
	const html = `<main>${"x".repeat(1_000_100)}${tail}</main>`;
	const document = parseHTML(html).document;
	const resources = discoverPageResources(
		html,
		"https://example.com/",
		false,
		document,
	);

	expect(resources.links).toContain("https://example.com/after-limit");
	expect(resources.truncated).toBeUndefined();
});

test("flags discovery truncation past the large HTML parse limit", async () => {
	const before = '<a href="/before-limit">Before</a>';
	const tail = '<a href="/after-limit">After</a>';
	const html = `<main>${before}${"x".repeat(1_000_100)}${tail}</main>`;
	const resources = discoverFetchedResources(
		okFetch("https://example.com/", html),
	);

	expect(resources.links).toContain("https://example.com/before-limit");
	expect(resources.truncated).toBeTrue();
});

test("rejects a large unfinished Markdown link corpus", async () => {
	const seed = "https://example.com/";
	const llms = `${seed}llms.txt`;
	const cache = new Map([
		[
			llms,
			Promise.resolve(
				okFetch(llms, `[Docs](${"x".repeat(1_000_000)}`, {
					contentType: "text/markdown",
				}),
			),
		],
	]);
	await expect(
		discoverLlms(
			seed,
			testConfig("unused", {
				seedUrl: seed,
				max: 10,
				maxExplicit: true,
			}),
			{ cache },
		),
	).resolves.toEqual([]);
});

test("uses section indexes instead of an available full corpus", async () => {
	const seed = "https://example.com/";
	const cache = new Map([
		[
			`${seed}llms.txt`,
			Promise.resolve(
				okFetch(
					`${seed}llms.txt`,
					"Full text: https://example.com/llms-full.txt\n\n- [Guide](https://example.com/guide/llms.txt)",
					{ contentType: "text/markdown" },
				),
			),
		],
		[
			"https://example.com/guide/llms.txt",
			Promise.resolve(
				okFetch(
					"https://example.com/guide/llms.txt",
					"- [One](/guide/one)\n- [Two](/guide/two)\n- [Three](/guide/three)",
					{ contentType: "text/markdown" },
				),
			),
		],
		[
			"https://example.com/llms-full.txt",
			Promise.resolve(
				okFetch(
					"https://example.com/llms-full.txt",
					"- [Bogus](/data)\n- [Old](/removed.mdx)",
					{ contentType: "text/markdown" },
				),
			),
		],
	]);
	const urls = await discoverLlms(
		seed,
		testConfig("unused", {
			seedUrl: seed,
			max: 20,
			maxExplicit: true,
		}),
		{ cache },
	);
	expect(urls).toEqual([
		"https://example.com/guide/one",
		"https://example.com/guide/two",
		"https://example.com/guide/three",
	]);
});

test("keeps a full corpus when the smaller index only links home", async () => {
	const seed = "https://example.com/";
	const cache = new Map([
		[
			`${seed}llms.txt`,
			Promise.resolve(
				okFetch(
					`${seed}llms.txt`,
					"- [Home](/)\n- [Full](https://example.com/llms-full.txt)",
					{ contentType: "text/markdown" },
				),
			),
		],
		[
			"https://example.com/llms-full.txt",
			Promise.resolve(
				okFetch(
					"https://example.com/llms-full.txt",
					"- [One](/one)\n- [Two](/two)\n- [Three](/three)",
					{ contentType: "text/markdown" },
				),
			),
		],
	]);
	const urls = await discoverLlms(
		seed,
		testConfig("unused", {
			seedUrl: seed,
			max: 20,
			maxExplicit: true,
		}),
		{ cache },
	);
	expect(urls).toEqual([
		"https://example.com/one",
		"https://example.com/two",
		"https://example.com/three",
	]);
});
