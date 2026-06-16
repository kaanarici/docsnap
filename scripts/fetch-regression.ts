import { createServer } from "node:http";
import { parseArgs } from "../src/cli/args.ts";
import type { Config } from "../src/core/types.ts";
import { discoverAssetPages } from "../src/discover/assets.ts";
import { discover } from "../src/discover/index.ts";
import { discoverSitemaps } from "../src/discover/sitemap.ts";
import { fetchText, setFetchTransportForTest } from "../src/fetch/fetcher.ts";
import {
	requestPublicHttp,
	setResolvePublicHttpUrlForTest,
} from "../src/fetch/transport.ts";
import { validatePublicHttpUrl } from "../src/security/url.ts";
import { html, httpResponse, typed } from "./fetch-fixtures.ts";

const config = parseArgs(["https://docs.example.com", "--page"]) as Config;
assert(!("help" in config) && !("version" in config));
assert(config.maxBytes === 12 * 1024 * 1024);
const discoverConfig = parseArgs(["https://docs.example.com/"]);
assert(!("help" in discoverConfig) && !("version" in discoverConfig));
const loopbackFallbackAddresses = [
	{ address: "127.0.0.2", family: 4 },
	{ address: "127.0.0.3", family: 4 },
	{ address: "127.0.0.1", family: 4 },
] satisfies Array<{ address: string; family: 4 }>;

const server = createServer((_req, res) => {
	res.writeHead(200, { "content-type": "text/plain" });
	res.end("second address");
});
const serverStarted = await new Promise<boolean>((resolve) => {
	server.once("error", () => resolve(false));
	server.listen(0, "127.0.0.1", () => resolve(true));
});
if (serverStarted) {
	try {
		const address = server.address();
		assert(address && typeof address !== "string");
		const raw = `http://multi.test:${address.port}/`;
		setResolvePublicHttpUrlForTest(async () => ({
			url: new URL(raw),
			hostname: "multi.test",
			address: "127.0.0.2",
			family: 4,
			addresses: loopbackFallbackAddresses,
		}));
		const response = await requestPublicHttp(
			raw,
			{ accept: "text/plain", "user-agent": config.userAgent },
			{ ...config, timeoutMs: 500 },
		);
		assert(response.status === 200);
		assert(new TextDecoder().decode(response.body) === "second address");
	} finally {
		setResolvePublicHttpUrlForTest(undefined);
		await new Promise<void>((resolve, reject) =>
			server.close((error) => (error ? reject(error) : resolve())),
		);
	}
}

const trickleServer = createServer((_req, res) => {
	res.writeHead(200, { "content-type": "text/plain" });
	let writes = 0;
	const timer = setInterval(() => {
		res.write("x");
		if (++writes >= 60) {
			clearInterval(timer);
			res.end();
		}
	}, 50);
	res.on("close", () => clearInterval(timer));
});
const trickleStarted = await new Promise<boolean>((resolve) => {
	trickleServer.once("error", () => resolve(false));
	trickleServer.listen(0, "127.0.0.1", () => resolve(true));
});
if (trickleStarted) {
	try {
		const address = trickleServer.address();
		assert(address && typeof address !== "string");
		const raw = `http://multi.test:${address.port}/`;
		setResolvePublicHttpUrlForTest(async () => ({
			url: new URL(raw),
			hostname: "multi.test",
			address: "127.0.0.2",
			family: 4,
			addresses: loopbackFallbackAddresses,
		}));
		const started = performance.now();
		let failure = "";
		try {
			await requestPublicHttp(
				raw,
				{ accept: "text/plain", "user-agent": config.userAgent },
				{ ...config, timeoutMs: 200 },
			);
		} catch (error) {
			failure = error instanceof Error ? error.message : String(error);
		}
		assert(/deadline exceeded/.test(failure));
		assert(performance.now() - started < 2_000);
	} finally {
		setResolvePublicHttpUrlForTest(undefined);
		await new Promise<void>((resolve, reject) =>
			trickleServer.close((error) => (error ? reject(error) : resolve())),
		);
	}
}

const conditionalHeadersSeen: Record<string, string>[] = [];
await withMockFetch(
	async () => {
		const result = await fetchText(
			"https://docs.example.com/cache",
			config,
			undefined,
			{
				etag: '"v1"',
				lastModified: "Tue, 01 Jan 2024 00:00:00 GMT",
				urls: ["https://docs.example.com/cache"],
			},
		);
		assert(result.ok);
		assert(conditionalHeadersSeen[0]?.["if-none-match"] === '"v1"');
		assert(
			conditionalHeadersSeen[0]?.["if-modified-since"] ===
				"Tue, 01 Jan 2024 00:00:00 GMT",
		);
	},
	async (_input, headers) => {
		conditionalHeadersSeen.push(headers);
		return html("Cached page");
	},
);
await withMockFetch(
	async () => {
		const result = await fetchText(
			"https://docs.example.com/not-modified",
			config,
			undefined,
			{ etag: '"v1"', urls: ["https://docs.example.com/not-modified"] },
		);
		assert(result.ok);
		assert(result.notModified === true);
		assert(result.status === 304);
		assert(result.body === "");
		assert(result.etag === '"v2"');
		assert(Boolean(result.fetchedAt));
	},
	async () =>
		new Response(null, {
			status: 304,
			headers: {
				etag: '"v2"',
				"last-modified": "Wed, 02 Jan 2024 00:00:00 GMT",
			},
		}),
);
const redirectHeaders: Array<{ url: string; headers: Record<string, string> }> =
	[];
await withMockFetch(
	async () => {
		const result = await fetchText(
			"https://docs.example.com/start",
			config,
			undefined,
			{ etag: '"start"', urls: ["https://docs.example.com/start"] },
		);
		assert(result.ok);
		assert(result.finalUrl === "https://other.example/target");
		assert(redirectHeaders[0]?.headers["if-none-match"] === '"start"');
		assert(!("if-none-match" in (redirectHeaders[1]?.headers ?? {})));
	},
	async (input, headers) => {
		redirectHeaders.push({ url: input, headers });
		return input === "https://docs.example.com/start"
			? Response.redirect("https://other.example/target", 302)
			: html("Redirect target");
	},
);
await withMockFetch(
	async () => {
		const result = await fetchText("https://93.184.216.34/challenge", config);
		assert(!result.ok);
		assert(result.failureKind === "blocked");
		assert(result.error === "blocked by client challenge");
	},
	async () =>
		new Response("", {
			status: 202,
			headers: { "x-amzn-waf-action": "challenge" },
		}),
);
await withMockFetch(
	async () => {
		const result = await fetchText(
			"https://93.184.216.34/quickstart.html",
			config,
		);
		assert(result.ok);
		assert(result.finalUrl === "https://93.184.216.34/quickstart");
		assert(result.body === "<main>Recovered HTML route</main>");
	},
	async (input) =>
		input.endsWith(".html")
			? new Response("missing", { status: 404 })
			: html("<main>Recovered HTML route</main>"),
);
await withMockFetch(
	async () => {
		const result = await fetchText("https://93.184.216.34/meta", config);
		assert(result.ok);
		assert(result.finalUrl === "https://93.184.216.34/meta");
	},
	async () =>
		html(
			`<noscript><meta http-equiv="refresh" content="0; URL=/fallback"></noscript><main>Readable docs page</main>`,
		),
);
await withMockFetch(
	async () => {
		const result = await fetchText("https://93.184.216.34/", config);
		assert(result.ok);
		assert(result.finalUrl === "https://93.184.216.34/latest/");
		assert(result.body === "<main>Current docs</main>");
	},
	async (input) =>
		input.endsWith("/latest/")
			? html("<main>Current docs</main>")
			: html(
					`<title>Redirecting</title><script>window.location.replace("latest/" + window.location.search + window.location.hash);</script>`,
				),
);
await withMockFetch(
	async () => {
		const result = await fetchText("https://93.184.216.34/learn", config);
		assert(result.ok);
		assert(result.finalUrl === "https://93.184.216.34/learn/intro/");
	},
	async (input) =>
		input.endsWith("/intro/")
			? typed("# Intro", "text/markdown")
			: html(
					`<p>If you are not redirected automatically please click here.</p><script>window.location = "/learn/intro/";</script>`,
				),
);
let refusedAttempts = 0;
await withMockFetch(
	async () => {
		const result = await fetchText("https://93.184.216.34/refused", config);
		assert(!result.ok);
		assert(result.failureKind === "fetch");
		assert(refusedAttempts === 1);
	},
	async () => {
		refusedAttempts++;
		throw new Error("connect ECONNREFUSED 93.184.216.34:443");
	},
);
let unsafeAttempts = 0;
await withMockFetch(
	async () => {
		const result = await fetchText("http://127.0.0.1/private", config);
		assert(!result.ok);
		assert(result.failureKind === "unsafe_url");
		assert(unsafeAttempts === 0);
	},
	async () => {
		unsafeAttempts++;
		return new Response("unreachable");
	},
);
await assertRedirectCookie(
	"https://a.co.uk/start",
	"https://b.co.uk/end",
	"sid=bad; Domain=co.uk; Path=/",
	undefined,
);
await assertRedirectCookie(
	"https://docs.example.co.uk/start",
	"https://www.example.co.uk/end",
	"sid=good; Domain=example.co.uk; Path=/",
	"sid=good",
);
let unsupportedSchemeCalls = 0;
await withMockFetch(
	async () => {
		const result = await fetchText("https://docs.example.com/ftp", config);
		assert(!result.ok);
		assert(result.failureKind === "unsafe_url");
		assert(unsupportedSchemeCalls === 1);
	},
	async (_input) => {
		unsupportedSchemeCalls++;
		return new Response("", {
			status: 301,
			headers: { location: "ftp://example.com/x" },
		});
	},
);
await withMockFetch(
	async () => {
		const result = await fetchText("https://docs.example.com/start", config);
		assert(result.ok);
		assert(result.finalUrl === "https://target.example/prompt");
		assert(result.redirects?.[0]?.to === "https://target.example/prompt");
	},
	async (input) =>
		input === "https://target.example/prompt"
			? html("Redirect target")
			: Response.redirect("https://target.example/prompt", 302),
);
await withMockFetch(
	async () => {
		const result = await fetchText("https://docs.example.com/start", config);
		assert(result.ok);
		assert(result.finalUrl === "https://target.example/prompt");
		assert(result.redirects?.[0]?.type === "refresh");
	},
	async (input) =>
		input === "https://target.example/prompt"
			? html("Redirect target")
			: html(
					`<meta http-equiv="refresh" content="0; url=https://target.example/prompt">`,
				),
);
const assetFetches: string[] = [];
setFetchTransportForTest(async (input) => {
	const url = String(input);
	assetFetches.push(url);
	return httpResponse(
		url,
		200,
		`path:"/docs",loadChildren:()=>import("https://cdn.example.net/chunk.js")`,
		"application/javascript",
	);
});
try {
	const pages = await discoverAssetPages(
		"https://docs.example.com/",
		`<html><head><base href="https://cdn.example.net/"></head><body><div id="app"></div><script src="main.js"></script></body></html>`,
		config,
		{ limit: 5, scope: "/", accept: () => true },
	);
	assert(pages.length === 0);
	assert(assetFetches.includes("https://cdn.example.net/main.js"));
	assert(!assetFetches.includes("https://docs.example.com/main.js"));
} finally {
	setFetchTransportForTest(undefined);
}
const explicitAssetFetches: string[] = [];
setFetchTransportForTest(async (input) => {
	const url = String(input);
	explicitAssetFetches.push(url);
	return httpResponse(
		url,
		200,
		url.endsWith("/main.js") ? `import("chunk.js")` : "console.log('chunk')",
		"application/javascript",
	);
});
try {
	const pages = await discoverAssetPages(
		"https://docs.example.com/",
		`<html><body><div id="app"></div><script src="https://cdn.example.net/main.js"></script></body></html>`,
		config,
		{ limit: 5, scope: "/", accept: () => true },
	);
	assert(pages.length === 0);
	assert(!explicitAssetFetches.includes("https://cdn.example.net/main.js"));
	assert(!explicitAssetFetches.includes("https://cdn.example.net/chunk.js"));
} finally {
	setFetchTransportForTest(undefined);
}
const sitemapFetches: string[] = [];
await withMockFetch(
	async () => {
		const urls = await discoverSitemaps(
			"https://docs.example.com/docs/",
			["https://evil.example/sitemap.xml"],
			config,
			{ limit: 2, scope: "/docs/", accept: () => true },
		);
		assert(urls.includes("https://docs.example.com/docs/intro"));
		assert(!sitemapFetches.includes("https://evil.example/sitemap.xml"));
	},
	async (input) => {
		sitemapFetches.push(input);
		if (input === "https://docs.example.com/sitemap.xml") {
			return typed(
				`<sitemapindex>
						<sitemap><loc>https://evil.example/sitemap.xml</loc></sitemap>
						<sitemap><loc>https://docs.example.com/docs/sitemap.xml</loc></sitemap>
					</sitemapindex>`,
				"application/xml",
			);
		}
		if (input === "https://docs.example.com/docs/sitemap.xml") {
			return typed(
				`<urlset><url><loc>https://docs.example.com/docs/intro</loc></url></urlset>`,
				"application/xml",
			);
		}
		return new Response("not found", { status: 404 });
	},
);
await withMockFetch(
	async () => {
		const urls = await discoverSitemaps(
			"https://docs.example.com/docs/",
			[],
			config,
			{ limit: 2, scope: "/docs/", accept: () => true },
		);
		assert(urls.length === 0);
	},
	async (input) =>
		input === "https://docs.example.com/sitemap.xml"
			? Response.redirect("https://evil.example/sitemap.xml", 302)
			: input === "https://evil.example/sitemap.xml"
				? typed(
						`<urlset><url><loc>https://docs.example.com/docs/intro</loc></url></urlset>`,
						"application/xml",
					)
				: new Response("not found", { status: 404 }),
);
await withMockFetch(
	async () => {
		const urls = await discover(discoverConfig);
		assert(!urls.some((item) => item.url.startsWith("https://evil.example/")));
	},
	async (input) =>
		input === "https://docs.example.com/llms.txt"
			? typed(
					Array.from(
						{ length: 5 },
						(_, index) => `- [Page ${index}](https://evil.example/${index}.md)`,
					).join("\n"),
					"text/plain",
				)
			: input === "https://docs.example.com/"
				? html("<main>Seed docs</main>")
				: new Response("not found", { status: 404 }),
);

function assert(condition: unknown): asserts condition {
	if (!condition) throw new Error("assertion failed");
}

async function withMockFetch(
	test: () => Promise<void>,
	mock: (input: string, headers: Record<string, string>) => Promise<Response>,
): Promise<void> {
	setFetchTransportForTest(async (input, headers) => {
		const unsafe = validatePublicHttpUrl(input);
		if (unsafe) throw new Error(unsafe);
		const response = await mock(input, headers);
		return {
			url: input,
			status: response.status,
			headers: { get: (name) => response.headers.get(name) },
			body: new Uint8Array(await response.arrayBuffer()),
		};
	});
	try {
		await test();
	} finally {
		setFetchTransportForTest(undefined);
	}
}

async function assertRedirectCookie(
	start: string,
	target: string,
	setCookie: string,
	expectCookie: string | undefined,
) {
	const calls: Array<{ url: string; headers: Record<string, string> }> = [];
	await withMockFetch(
		async () => {
			const result = await fetchText(start, config);
			const headers = calls.find((call) => call.url === target)?.headers;
			assert(result.ok);
			// biome-ignore lint/complexity/useLiteralKeys: tsconfig requires index access
			assert(headers?.["cookie"] === expectCookie);
		},
		async (input, headers) => {
			calls.push({ url: input, headers });
			return input === start
				? new Response("", {
						status: 302,
						headers: { location: target, "set-cookie": setCookie },
					})
				: html("Target");
		},
	);
}
