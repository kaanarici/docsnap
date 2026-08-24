import { describe, expect, onTestFinished, test } from "bun:test";
import { startDiscovery } from "../src/discover/index.ts";
import { discoverLlms } from "../src/discover/llms.ts";
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
