import { afterEach, describe, expect, test } from "bun:test";
import { buildPipelineConfig, parseArgs } from "../src/cli/args.ts";
import { sameSiteLabel } from "../src/core/url.ts";
import { discover } from "../src/discover/index.ts";
import { setFetchTransportForTest } from "../src/fetch/fetcher.ts";
import { buildSummary } from "../src/report/summary.ts";

function makeConfig(...args: string[]) {
	const parsed = parseArgs(args);
	if ("help" in parsed || "version" in parsed) {
		throw new Error("parseArgs returned help/version");
	}
	return buildPipelineConfig(parsed.run);
}
function hasUrl(items: Array<{ url: string }>, url: string) {
	return items.some((item) => item.url === url);
}
function hasUrlStartingWith(items: Array<{ url: string }>, prefix: string) {
	return items.some((item) => item.url.startsWith(prefix));
}
function hasUrlContaining(items: Array<{ url: string }>, fragment: string) {
	return items.some((item) => item.url.includes(fragment));
}
afterEach(() => {
	setFetchTransportForTest(undefined);
});
describe("same-site labeling", () => {
	test("rejects public-suffix sibling impostors and allows related Stripe hosts", () => {
		expect(sameSiteLabel("docs.example.co.uk", "evil.attacker.co.uk")).toBe(
			false,
		);
		expect(sameSiteLabel("docs.example.com.au", "evil.attacker.com.au")).toBe(
			false,
		);
		expect(sameSiteLabel("docs.stripe.com", "stripe.dev")).toBe(true);
	});
});

describe("llms discovery redirects", () => {
	test("rejects unrelated llms.txt redirect targets", async () => {
		const config = makeConfig("https://docs.example.com/docs/", "-m", "5");
		setFetchTransportForTest(async (input) => {
			const url = String(input);
			if (url === "https://docs.example.com/llms.txt") {
				return response(
					url,
					302,
					"",
					"text/plain",
					"https://evil.example/llms.txt",
				);
			}
			if (url === "https://evil.example/llms.txt") {
				return response(
					url,
					200,
					Array.from(
						{ length: 5 },
						(_, index) => `- [Evil ${index}](https://evil.example/${index}.md)`,
					).join("\n"),
					"text/markdown",
				);
			}
			return response(url, 404, "not found", "text/plain");
		});
		const discovered = await discover(config);
		expect(hasUrlStartingWith(discovered, "https://evil.example/")).toBe(false);
	});
	test("allows moved-brand llms.txt redirects", async () => {
		const movedBrandConfig = makeConfig("https://rspack.dev/guide/", "-m", "6");
		setFetchTransportForTest(async (input) => {
			const url = String(input);
			if (url === "https://rspack.dev/llms.txt") {
				return response(
					url,
					301,
					"",
					"text/plain",
					"https://rspack.rs/llms.txt",
				);
			}
			if (url === "https://rspack.rs/llms.txt") {
				return response(
					url,
					200,
					Array.from(
						{ length: 5 },
						(_, index) =>
							`- [Guide ${index}](https://rspack.rs/guide/${index}.md)`,
					).join("\n"),
					"text/markdown",
				);
			}
			return response(url, 404, "not found", "text/plain");
		});
		const discovered = await discover(movedBrandConfig);
		expect(hasUrlStartingWith(discovered, "https://rspack.rs/")).toBe(true);
	});
	test("allows readthedocs project corpus links", async () => {
		const readTheDocsConfig = makeConfig(
			"https://foo.readthedocs.io/en/latest/",
			"-m",
			"6",
		);
		setFetchTransportForTest(async (input) => {
			const url = String(input);
			if (url === "https://foo.readthedocs.io/en/latest/llms.txt") {
				return response(
					url,
					200,
					Array.from(
						{ length: 5 },
						(_, index) =>
							`- [Page ${index}](https://project.readthedocs.io/en/latest/${index}.html)`,
					).join("\n"),
					"text/markdown",
				);
			}
			return response(url, 404, "not found", "text/plain");
		});
		const discovered = await discover(readTheDocsConfig);
		expect(
			hasUrlStartingWith(
				discovered,
				"https://project.readthedocs.io/en/latest/",
			),
		).toBe(true);
	});
});
describe("redirect summaries", () => {
	test("counts only successful host redirects", () => {
		const config = makeConfig("https://docs.example.com/docs/", "-m", "5");
		const failedRedirectSummary = buildSummary(
			[
				{
					ok: false,
					url: "https://docs.example.com/start",
					finalUrl: "https://evil.example/prompt",
					redirects: [
						{
							from: "https://docs.example.com/start",
							to: "https://evil.example/prompt",
							type: "http",
							status: 302,
						},
					],
					fetchedAt: "2026-01-01T00:00:00.000Z",
					injectionSignals: [],
					status: 0,
					source: "seed",
					timings: { fetchMs: 1, extractMs: 0, writeMs: 0 },
					markdown: "",
					links: [],
					contentHash: "",
					extractor: "none",
					confidence: 0,
					qualityReasons: [],
					error: "URL credentials are not allowed",
					failureKind: "unsafe_url",
				},
			],
			config,
			1,
			0,
			{ rootHash: "hash", files: 0, bytes: 0 },
			1,
		);
		expect(failedRedirectSummary.hostRedirects).toBe(0);
		expect(failedRedirectSummary.redirectedHosts).toHaveLength(0);
		const successfulRedirectSummary = buildSummary(
			[
				{
					ok: true,
					url: "https://docs.example.com/start",
					finalUrl: "https://target.example/guide",
					redirects: [
						{
							from: "https://docs.example.com/start",
							to: "https://target.example/guide",
							type: "http",
							status: 302,
						},
					],
					fetchedAt: "2026-01-01T00:00:00.000Z",
					injectionSignals: [],
					status: 200,
					source: "seed",
					timings: { fetchMs: 1, extractMs: 1, writeMs: 0 },
					markdown: "# Guide",
					links: [],
					contentHash: "hash",
					extractor: "html",
					confidence: 1,
					qualityReasons: [],
					outputPath: "guide.md",
				},
			],
			config,
			1,
			0,
			{ rootHash: "hash", files: 1, bytes: 1 },
			1,
		);
		expect(successfulRedirectSummary.hostRedirects).toBeGreaterThan(0);
		expect(
			successfulRedirectSummary.redirectedHosts.some(
				(item) =>
					item.from === "docs.example.com" &&
					item.to === "target.example" &&
					item.count === 1,
			),
		).toBe(true);
	});
});
describe("robots-gated discovery", () => {
	test("gates llms corpus expansion links before fetching", async () => {
		const llmsExpandConfig = makeConfig(
			"https://llmsexpand.example/",
			"-m",
			"5",
		);
		const llmsExpandFetches: string[] = [];
		setFetchTransportForTest(async (input) => {
			const url = String(input);
			llmsExpandFetches.push(url);
			if (url === "https://llmsexpand.example/robots.txt") {
				return response(
					url,
					200,
					"User-agent: *\nDisallow: /private/",
					"text/plain",
				);
			}
			if (url === "https://llmsexpand.example/llms.txt") {
				return response(
					url,
					200,
					"# Corpus\n- [Guide](/docs/guide.md)\n- [Private](/private/index.md)\n- [More](/docs/more.md)\n- [Extra](/docs/extra.md)\n- [Other](/docs/other.md)\n",
					"text/plain",
				);
			}
			if (url === "https://llmsexpand.example/private/index.md") {
				throw new Error("robots-disallowed llms expansion link fetched");
			}
			return response(url, 404, "not found", "text/plain");
		});
		const urls = await discover(llmsExpandConfig);
		expect(llmsExpandFetches).not.toContain(
			"https://llmsexpand.example/private/index.md",
		);
		expect(hasUrl(urls, "https://llmsexpand.example/docs/guide.md")).toBe(true);
	});
	test("keeps disallowed llms.txt redirects out of the corpus", async () => {
		const llmsRedirectConfig = makeConfig(
			"https://llmsredir.example/",
			"-m",
			"3",
		);
		setFetchTransportForTest(async (input) => {
			const url = String(input);
			if (url === "https://llmsredir.example/robots.txt") {
				return response(
					url,
					200,
					"User-agent: *\nDisallow: /private/",
					"text/plain",
				);
			}
			if (url === "https://llmsredir.example/llms.txt") {
				return response(url, 301, "", "text/plain", "/private/llms.txt");
			}
			if (url === "https://llmsredir.example/private/llms.txt") {
				return response(
					url,
					200,
					"# Secret corpus\n- [Hidden](/private/hidden.md)\n",
					"text/plain",
				);
			}
			if (url === "https://llmsredir.example/") {
				return response(
					url,
					200,
					`<html><body><main><a href="/docs/guide">Guide</a></main></body></html>`,
					"text/html",
				);
			}
			return response(url, 404, "not found", "text/plain");
		});
		const urls = await discover(llmsRedirectConfig);
		expect(urls.some((item) => item.source === "llms")).toBe(false);
		expect(hasUrlContaining(urls, "/private/")).toBe(false);
	});
	test("uses declared sitemap allow carve-outs without fetching blocked seed", async () => {
		const carveOutConfig = makeConfig("https://carveout.example/", "-m", "5");
		const carveOutFetches: string[] = [];
		setFetchTransportForTest(async (input) => {
			const url = String(input);
			carveOutFetches.push(url);
			if (url === "https://carveout.example/robots.txt") {
				return response(
					url,
					200,
					[
						"User-agent: *",
						"Disallow: /",
						"Allow: /en/stable",
						"Sitemap: https://carveout.example/declared-sitemap.xml",
					].join("\n"),
					"text/plain",
				);
			}
			if (url === "https://carveout.example/declared-sitemap.xml") {
				return response(
					url,
					200,
					`<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
				<url><loc>https://carveout.example/en/stable/intro</loc></url>
				<url><loc>https://carveout.example/en/stable/config</loc></url>
				<url><loc>https://carveout.example/private/admin</loc></url>
			</urlset>`,
					"application/xml",
				);
			}
			if (url === "https://carveout.example/") {
				throw new Error("disallowed seed fetched");
			}
			if (url === "https://carveout.example/sitemap.xml") {
				throw new Error("undeclared sitemap probed despite Disallow:/");
			}
			return response(url, 404, "not found", "text/plain");
		});
		const urls = await discover(carveOutConfig);
		expect(hasUrl(urls, "https://carveout.example/en/stable/intro")).toBe(true);
		expect(hasUrl(urls, "https://carveout.example/en/stable/config")).toBe(
			true,
		);
		expect(hasUrlContaining(urls, "/private/")).toBe(false);
		expect(carveOutFetches).not.toContain("https://carveout.example/");
		expect(carveOutFetches).not.toContain(
			"https://carveout.example/sitemap.xml",
		);
	});
	test("does not probe sitemaps for fully blocked origins", async () => {
		const fullyBlockedConfig = makeConfig(
			"https://fullyblocked.example/",
			"-m",
			"3",
		);
		const fullyBlockedFetches: string[] = [];
		setFetchTransportForTest(async (input) => {
			const url = String(input);
			fullyBlockedFetches.push(url);
			if (url === "https://fullyblocked.example/robots.txt") {
				return response(url, 200, "User-agent: *\nDisallow: /", "text/plain");
			}
			if (url.includes("sitemap")) {
				throw new Error("sitemap probed on fully blocked origin");
			}
			if (url === "https://fullyblocked.example/") {
				throw new Error("disallowed seed fetched");
			}
			return response(url, 404, "not found", "text/plain");
		});
		const urls = await discover(fullyBlockedConfig);
		expect(urls).toHaveLength(1);
		const fetched = urls[0]?.fetched;
		expect(fetched?.ok).toBe(false);
		if (!fetched || fetched.ok) {
			throw new Error("expected blocked fetched result");
		}
		expect(fetched.failureKind).toBe("blocked");
		expect(fullyBlockedFetches[0]).toBe(
			"https://fullyblocked.example/robots.txt",
		);
		expect(fullyBlockedFetches.some((url) => url.includes("sitemap"))).toBe(
			false,
		);
	});
	test("restarts apex discovery on related www redirects with robots gating", async () => {
		const apexConfig = makeConfig("https://apex.example/", "-m", "4");
		const apexFetches: string[] = [];
		setFetchTransportForTest(async (input) => {
			const url = String(input);
			apexFetches.push(url);
			if (url === "https://apex.example/robots.txt") {
				throw new Error("connect ECONNREFUSED apex.example:443");
			}
			if (url === "https://apex.example/") {
				return response(
					url,
					301,
					"",
					"text/plain",
					"https://www.apex.example/",
				);
			}
			if (url === "https://www.apex.example/robots.txt") {
				return response(
					url,
					200,
					"User-agent: *\nDisallow: /private/",
					"text/plain",
				);
			}
			if (url === "https://www.apex.example/") {
				return response(
					url,
					200,
					`<html><body><main><a href="/guide">Guide</a><a href="/private/x">No</a></main></body></html>`,
					"text/html",
				);
			}
			if (url === "https://www.apex.example/guide") {
				return response(
					url,
					200,
					"<html><body><main><h1>Guide</h1><p>Readable canonical content here.</p></main></body></html>",
					"text/html",
				);
			}
			return response(url, 404, "not found", "text/plain");
		});
		const urls = await discover(apexConfig);
		expect(hasUrl(urls, "https://www.apex.example/guide")).toBe(true);
		expect(hasUrlContaining(urls, "/private/")).toBe(false);
		expect(apexFetches).toContain("https://www.apex.example/robots.txt");
	});
	test("treats literal allow prefixes as entry invitations", async () => {
		const allowPrefixConfig = makeConfig("https://prefix.example/", "-m", "4");
		const allowPrefixFetches: string[] = [];
		setFetchTransportForTest(async (input) => {
			const url = String(input);
			allowPrefixFetches.push(url);
			if (url === "https://prefix.example/robots.txt") {
				return response(
					url,
					200,
					"User-agent: *\nDisallow: /\nAllow: /latest/",
					"text/plain",
				);
			}
			if (url === "https://prefix.example/") {
				throw new Error("disallowed root fetched");
			}
			if (url === "https://prefix.example/latest/") {
				return response(
					url,
					200,
					`<html><body><main><h1>Latest</h1><p>Docs index with real text.</p><a href="/latest/setup">Setup</a></main></body></html>`,
					"text/html",
				);
			}
			if (url === "https://prefix.example/latest/setup") {
				return response(
					url,
					200,
					"<html><body><main><h1>Setup</h1><p>Install and configure things.</p></main></body></html>",
					"text/html",
				);
			}
			return response(url, 404, "not found", "text/plain");
		});
		const urls = await discover(allowPrefixConfig);
		expect(hasUrl(urls, "https://prefix.example/latest/")).toBe(true);
		expect(hasUrl(urls, "https://prefix.example/latest/setup")).toBe(true);
		expect(allowPrefixFetches).not.toContain("https://prefix.example/");
	});
});
function response(
	url: string,
	status: number,
	body: string,
	contentType: string,
	location?: string,
) {
	return {
		url,
		status,
		headers: {
			get: (name: string) =>
				name === "content-type"
					? contentType
					: name === "location"
						? (location ?? null)
						: null,
			getSetCookie: () => [],
		},
		body: new TextEncoder().encode(body),
	};
}
