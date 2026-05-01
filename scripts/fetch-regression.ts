import { parseArgs } from "../src/cli/args.ts";
import { fetchText, setFetchTransportForTest } from "../src/fetch/fetcher.ts";
import { validatePublicHttpUrl } from "../src/security/url.ts";

const config = parseArgs(["https://docs.example.com", "--page"]);
assert(!("help" in config) && !("version" in config));
assert(config.maxBytes === 12 * 1024 * 1024);

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
			: new Response("<main>Recovered HTML route</main>", {
					headers: { "content-type": "text/html" },
				}),
);
await withMockFetch(
	async () => {
		const result = await fetchText("https://93.184.216.34/meta", config);
		assert(result.ok);
		assert(result.finalUrl === "https://93.184.216.34/meta");
	},
	async () =>
		new Response(
			`<noscript><meta http-equiv="refresh" content="0; URL=/fallback"></noscript><main>Readable docs page</main>`,
			{ headers: { "content-type": "text/html" } },
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
			? new Response("<main>Current docs</main>", {
					headers: { "content-type": "text/html" },
				})
			: new Response(
					`<title>Redirecting</title><script>window.location.replace("latest/" + window.location.search + window.location.hash);</script>`,
					{ headers: { "content-type": "text/html" } },
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
			? new Response("# Intro", {
					headers: { "content-type": "text/markdown" },
				})
			: new Response(
					`<p>If you are not redirected automatically please click here.</p><script>window.location = "/learn/intro/";</script>`,
					{ headers: { "content-type": "text/html" } },
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

function assert(condition: unknown): asserts condition {
	if (!condition) throw new Error("assertion failed");
}

async function withMockFetch(
	test: () => Promise<void>,
	mock: (input: string) => Promise<Response>,
): Promise<void> {
	setFetchTransportForTest(async (input) => {
		const unsafe = validatePublicHttpUrl(input);
		if (unsafe) throw new Error(unsafe);
		const response = await mock(input);
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
