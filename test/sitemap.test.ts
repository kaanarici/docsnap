import { afterEach, describe, expect, test } from "bun:test";
import { buildPipelineConfig, parseArgs } from "../src/cli/args.ts";
import { discover } from "../src/discover/index.ts";
import { discoverSitemaps } from "../src/discover/sitemap.ts";
import { setFetchTransportForTest } from "../src/fetch/fetcher.ts";

const parsed = config(["https://docs.example.com/", "-m", "4"]);
const rateLimitedConfig = { ...parsed, concurrency: 8, perOrigin: 2 };

describe("sitemap discovery", () => {
	afterEach(() => {
		setFetchTransportForTest(undefined);
	});

	test("stops at the requested limit without fetching sitemap-index children", async () => {
		const sitemapFetches: string[] = [];
		setFetchTransportForTest(async (input) => {
			const url = String(input);
			sitemapFetches.push(url);
			const body = url.endsWith("/sitemap.xml")
				? `<sitemapindex><sitemap><loc>https://docs.example.com/sitemappart/1.xml</loc></sitemap><sitemap><loc>https://docs.example.com/sitemappart/2.xml</loc></sitemap></sitemapindex>`
				: `<urlset><url><loc>https://docs.example.com/docs/intro</loc></url></urlset>`;
			return {
				url,
				status: 200,
				headers: {
					get: (name) => (name === "content-type" ? "application/xml" : null),
					getSetCookie: () => [],
				},
				body: new TextEncoder().encode(body),
			};
		});

		const urls = await discoverSitemaps(
			"https://docs.example.com/docs/",
			[],
			parsed,
			{
				limit: 1,
				scope: "/docs/",
				accept: () => true,
			},
		);
		expect(urls).toHaveLength(1);
		expect(urls[0]).toBe("https://docs.example.com/docs/intro");
		expect(sitemapFetches).not.toContain(
			"https://docs.example.com/sitemappart/1.xml",
		);
	});

	test("does not build a backtracking regex from attacker-controlled scope", async () => {
		setFetchTransportForTest(async (input) => {
			const url = String(input);
			const longPath = `${"a".repeat(40)}b`;
			const body = url.endsWith("/sitemap.xml")
				? `<sitemapindex>${Array.from(
						{ length: 20 },
						(_, i) =>
							`<sitemap><loc>https://redos.example/${longPath}-${i}.xml</loc></sitemap>`,
					).join("")}</sitemapindex>`
				: `<urlset></urlset>`;
			return {
				url,
				status: 200,
				headers: {
					get: (name: string) =>
						name === "content-type" ? "application/xml" : null,
					getSetCookie: () => [],
				},
				body: new TextEncoder().encode(body),
			};
		});

		const start = performance.now();
		await discoverSitemaps(
			"https://redos.example/",
			["https://redos.example/sitemap.xml"],
			rateLimitedConfig,
			{ limit: 5, scope: "/(a+)+/", accept: () => true },
		);
		const elapsed = performance.now() - start;
		expect(elapsed).toBeLessThan(2000);
	});

	test("prefers the scoped locale sitemap over a broader provided sitemap", async () => {
		const scopedSitemapFetches: string[] = [];
		setFetchTransportForTest(async (input) => {
			const url = String(input);
			scopedSitemapFetches.push(url);
			if (url.endsWith("/us-en.sitemap.xml")) {
				return response(
					url,
					200,
					`<urlset><url><loc>https://vendor.example.com/us-en/privacy</loc></url></urlset>`,
					"application/xml",
				);
			}
			return response(url, 200, `<urlset></urlset>`, "application/xml");
		});

		const urls = await discoverSitemaps(
			"https://vendor.example.com/us-en",
			["https://vendor.example.com/broad-sitemap.xml"],
			parsed,
			{
				limit: 1,
				scope: "/us-en/",
				accept: (url) => url.includes("/us-en/"),
			},
		);
		expect(urls[0]).toBe("https://vendor.example.com/us-en/privacy");
		expect(scopedSitemapFetches).not.toContain(
			"https://vendor.example.com/broad-sitemap.xml",
		);
	});

	test("prefers a matching locale sitemap child over an unrelated support child", async () => {
		const localeSitemapFetches: string[] = [];
		setFetchTransportForTest(async (input) => {
			const url = String(input);
			localeSitemapFetches.push(url);
			if (url.endsWith("/sitemap.xml")) {
				return response(
					url,
					200,
					`<sitemapindex>
				<sitemap><loc>https://vendor.example.com/support/sitemap-1.xml</loc></sitemap>
				<sitemap><loc>https://vendor.example.com/href-sitemap-en-us.xml</loc></sitemap>
			</sitemapindex>`,
					"application/xml",
				);
			}
			if (url.endsWith("/href-sitemap-en-us.xml")) {
				return response(
					url,
					200,
					`<urlset><url><loc>https://vendor.example.com/us-en/docs/privacy</loc></url></urlset>`,
					"application/xml",
				);
			}
			return response(url, 200, `<urlset></urlset>`, "application/xml");
		});

		const urls = await discoverSitemaps(
			"https://vendor.example.com/us-en/",
			[],
			parsed,
			{
				limit: 1,
				scope: "/us-en/",
				accept: (url) => url.includes("/us-en/"),
			},
		);
		expect(urls[0]).toBe("https://vendor.example.com/us-en/docs/privacy");
		expect(localeSitemapFetches).not.toContain(
			"https://vendor.example.com/support/sitemap-1.xml",
		);
	});

	test("keeps URL-like sitemap index entries as URLs without fetching routes", async () => {
		const malformedIndexFetches: string[] = [];
		setFetchTransportForTest(async (input) => {
			const url = String(input);
			malformedIndexFetches.push(url);
			return response(
				url,
				200,
				`<sitemapindex>
			<sitemap><loc>https://app.example.com/route</loc></sitemap>
			<sitemap><loc>https://app.example.com/docs/intro</loc></sitemap>
		</sitemapindex>`,
				"application/xml",
			);
		});

		const urls = await discoverSitemaps(
			"https://app.example.com/",
			["https://app.example.com/sitemap.xml"],
			parsed,
			{
				limit: 2,
				scope: "/",
				accept: () => true,
			},
		);
		expect(urls).toContain("https://app.example.com/docs/intro");
		expect(malformedIndexFetches).not.toContain(
			"https://app.example.com/route",
		);
	});

	test("limits concurrent sitemap child fetches per origin", async () => {
		let sitemapActive = 0;
		let sitemapPeak = 0;
		setFetchTransportForTest(async (input) => {
			const url = String(input);
			if (url.endsWith("/sitemap.xml")) {
				const children = Array.from(
					{ length: 8 },
					(_, index) =>
						`<sitemap><loc>https://rate.example/sitemaps/part-${index + 1}.xml</loc></sitemap>`,
				).join("");
				return response(url, 200, `<sitemapindex>${children}</sitemapindex>`);
			}
			if (/\/part-\d+\.xml$/.test(url)) {
				sitemapActive++;
				sitemapPeak = Math.max(sitemapPeak, sitemapActive);
				await Bun.sleep(20);
				sitemapActive--;
				return response(url, 200, "<urlset></urlset>", "application/xml");
			}
			return response(url, 200, "<urlset></urlset>", "application/xml");
		});

		await discoverSitemaps(
			"https://rate.example/docs/",
			["https://rate.example/sitemap.xml"],
			rateLimitedConfig,
			{
				limit: 20,
				scope: "/docs/",
				accept: () => false,
			},
		);
		expect(sitemapPeak).toBeLessThanOrEqual(rateLimitedConfig.perOrigin);
	});

	test("uses robots sitemaps after a language selector redirect", async () => {
		const languageConfig = config(["https://eu.example/", "-m", "2"]);
		setFetchTransportForTest(async (input) => {
			const url = String(input);
			if (url.endsWith("/robots.txt")) {
				return response(
					url,
					200,
					"Sitemap: https://commission.example/sitemap.xml",
					"text/plain",
				);
			}
			if (url.endsWith("/sitemap.xml")) {
				return response(
					url,
					200,
					`<urlset><url><loc>https://commission.example/index_en</loc></url></urlset>`,
					"application/xml",
				);
			}
			if (url === "https://eu.example/") {
				return response(
					url,
					302,
					"",
					"text/html",
					"https://commission.example/select-language?destination=/node/1",
				);
			}
			if (
				url === "https://commission.example/select-language?destination=/node/1"
			) {
				return response(
					url,
					200,
					`<html><body class="path-select-language"><main></main></body></html>`,
				);
			}
			return response(url, 404, "not found", "text/plain");
		});

		const urls = await discover(languageConfig);
		expect(urls).toHaveLength(1);
		expect(urls[0]?.url).toBe("https://commission.example/index_en");
		expect(urls[0]?.source).toBe("sitemap");
	});

	test("follows matching nested sitemap locs from a urlset", async () => {
		const urlsetSitemapFetches: string[] = [];
		setFetchTransportForTest(async (input) => {
			const url = String(input);
			urlsetSitemapFetches.push(url);
			if (url.endsWith("/documentation/sitemap.xml")) {
				return response(
					url,
					200,
					`<urlset>
				<url><loc>https://dev.example/community/api/documentation/sitemaps/fortnite/sitemap_99.xml</loc></url>
				<url><loc>https://dev.example/community/api/documentation/sitemaps/unreal_engine/sitemap_1.xml</loc></url>
			</urlset>`,
					"application/xml",
				);
			}
			if (url.endsWith("/sitemap_1.xml")) {
				return response(
					url,
					200,
					`<urlset><url><loc>https://dev.example/documentation/en-us/unreal-engine/installing-unreal-engine</loc></url></urlset>`,
					"application/xml",
				);
			}
			return response(url, 404, "not found", "text/plain");
		});

		const urls = await discoverSitemaps(
			"https://dev.example/documentation/en-us/unreal-engine/",
			["https://dev.example/documentation/sitemap.xml"],
			parsed,
			{
				limit: 1,
				scope: "/documentation/unreal-engine/",
				accept: () => true,
			},
		);
		expect(urls).toHaveLength(1);
		expect(urls[0]).toBe(
			"https://dev.example/documentation/en-us/unreal-engine/installing-unreal-engine",
		);
		expect(urlsetSitemapFetches).toContain(
			"https://dev.example/community/api/documentation/sitemaps/unreal_engine/sitemap_1.xml",
		);
		expect(urlsetSitemapFetches).not.toContain(
			"https://dev.example/community/api/documentation/sitemaps/fortnite/sitemap_99.xml",
		);
	});

	test("stops after five blocked sitemap children", async () => {
		let blockedSitemapChildren = 0;
		setFetchTransportForTest(async (input) => {
			const url = String(input);
			if (url.endsWith("/documentation/sitemap.xml")) {
				const children = Array.from(
					{ length: 6 },
					(_, index) =>
						`<sitemap><loc>https://blocked.example/documentation/sitemap_${index + 1}.xml</loc></sitemap>`,
				).join("");
				return response(url, 200, `<sitemapindex>${children}</sitemapindex>`);
			}
			if (/\/sitemap_\d+\.xml$/.test(url)) {
				blockedSitemapChildren++;
				return response(url, 403, "blocked", "text/html");
			}
			return response(url, 404, "not found", "text/plain");
		});

		const urls = await discoverSitemaps(
			"https://blocked.example/documentation/guide/",
			["https://blocked.example/documentation/sitemap.xml"],
			parsed,
			{
				limit: 1,
				scope: "/documentation/",
				accept: () => true,
			},
		);
		expect(urls).toHaveLength(0);
		expect(blockedSitemapChildren).toBe(5);
	});

	test("does not fetch a robots-disallowed declared sitemap during normal discovery", async () => {
		const declaredBypassConfig = config([
			"https://declbypass.example/public/",
			"-m",
			"6",
		]);
		const declaredBypassFetches: string[] = [];
		setFetchTransportForTest(async (input) => {
			const url = String(input);
			declaredBypassFetches.push(url);
			if (url === "https://declbypass.example/robots.txt") {
				return response(
					url,
					200,
					[
						"User-agent: *",
						"Disallow: /",
						"Allow: /public/",
						"Sitemap: https://declbypass.example/secret-sitemap.xml",
					].join("\n"),
					"text/plain",
				);
			}
			if (url === "https://declbypass.example/secret-sitemap.xml") {
				throw new Error("robots-disallowed declared sitemap fetched");
			}
			if (url === "https://declbypass.example/public/") {
				return response(
					url,
					200,
					`<html><body><main><h1>Public</h1><p>Readable public docs.</p><a href="/public/page">More</a></main></body></html>`,
				);
			}
			if (url === "https://declbypass.example/public/page") {
				return response(
					url,
					200,
					"<html><body><main><h1>Page</h1><p>Another readable public page.</p></main></body></html>",
				);
			}
			return response(url, 404, "not found", "text/plain");
		});

		const urls = await discover(declaredBypassConfig);
		expect(
			urls.some((item) => item.url === "https://declbypass.example/public/"),
		).toBe(true);
		expect(urls.some((item) => item.url.includes("/secret"))).toBe(false);
		expect(declaredBypassFetches).not.toContain(
			"https://declbypass.example/secret-sitemap.xml",
		);
	});
});

function config(args: string[]) {
	const parsedArgs = parseArgs(args);
	if ("help" in parsedArgs || "version" in parsedArgs) {
		throw new Error("parseArgs returned help/version");
	}
	return buildPipelineConfig(parsedArgs.run);
}

function response(
	url: string,
	status: number,
	body: string,
	contentType = "text/html",
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
