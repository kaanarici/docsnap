import { parseArgs } from "../src/cli/args.ts";
import { fetchText, setFetchTransportForTest } from "../src/fetch/fetcher.ts";
import { validatePublicHttpUrl } from "../src/security/url.ts";

const config = parseArgs(["https://docs.example.com", "--page"]);
assert(!("help" in config) && !("version" in config));

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
