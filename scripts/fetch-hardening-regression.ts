import { createServer } from "node:http";
import { parseArgs } from "../src/cli/args.ts";
import { fetchText, setFetchTransportForTest } from "../src/fetch/fetcher.ts";
import {
	requestPublicHttp,
	setResolvePublicHttpUrlForTest,
} from "../src/fetch/transport.ts";
import { validatePublicHttpUrl } from "../src/security/url.ts";

const config = parseArgs(["https://docs.example.com", "--page"]);
assert(!("help" in config) && !("version" in config));

const sharedDeadlineServer = createServer((_req, res) => {
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
const sharedDeadlineStarted = await new Promise<boolean>((resolve) => {
	sharedDeadlineServer.once("error", () => resolve(false));
	sharedDeadlineServer.listen(0, "127.0.0.1", () => resolve(true));
});
if (sharedDeadlineStarted) {
	try {
		const address = sharedDeadlineServer.address();
		assert(address && typeof address !== "string");
		const raw = `http://multi.test:${address.port}/`;
		setResolvePublicHttpUrlForTest(async () => ({
			url: new URL(raw),
			hostname: "multi.test",
			address: "127.0.0.2",
			family: 4,
			addresses: [
				{ address: "127.0.0.2", family: 4 },
				{ address: "127.0.0.3", family: 4 },
				{ address: "127.0.0.1", family: 4 },
			],
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
			sharedDeadlineServer.close((error) =>
				error ? reject(error) : resolve(),
			),
		);
	}
}

const publicSuffixCookieCalls: Array<{
	url: string;
	headers: Record<string, string>;
}> = [];
await withMockFetch(
	async () => {
		const result = await fetchText("https://a.co.uk/start", config);
		const endHeaders = publicSuffixCookieCalls.find(
			(call) => call.url === "https://b.co.uk/end",
		)?.headers;
		assert(result.ok);
		assert(
			// biome-ignore lint/complexity/useLiteralKeys: tsconfig requires index access
			endHeaders?.["cookie"] === undefined,
		);
	},
	async (input, headers) => {
		publicSuffixCookieCalls.push({ url: input, headers });
		return input === "https://a.co.uk/start"
			? new Response("", {
					status: 302,
					headers: {
						location: "https://b.co.uk/end",
						"set-cookie": "sid=bad; Domain=co.uk; Path=/",
					},
				})
			: new Response("Target", { headers: { "content-type": "text/html" } });
	},
);

const parentDomainCookieCalls: Array<{
	url: string;
	headers: Record<string, string>;
}> = [];
await withMockFetch(
	async () => {
		const result = await fetchText("https://docs.example.co.uk/start", config);
		assert(result.ok);
		assert(
			parentDomainCookieCalls.find(
				(call) => call.url === "https://www.example.co.uk/end",
				// biome-ignore lint/complexity/useLiteralKeys: tsconfig requires index access
			)?.headers["cookie"] === "sid=good",
		);
	},
	async (input, headers) => {
		parentDomainCookieCalls.push({ url: input, headers });
		return input === "https://docs.example.co.uk/start"
			? new Response("", {
					status: 302,
					headers: {
						location: "https://www.example.co.uk/end",
						"set-cookie": "sid=good; Domain=example.co.uk; Path=/",
					},
				})
			: new Response("Target", { headers: { "content-type": "text/html" } });
	},
);

const unsupportedSchemeCalls: string[] = [];
await withMockFetch(
	async () => {
		const result = await fetchText("https://docs.example.com/ftp", config);
		assert(!result.ok);
		assert(result.failureKind === "unsafe_url");
		assert(unsupportedSchemeCalls.length === 1);
	},
	async (input) => {
		unsupportedSchemeCalls.push(input);
		return new Response("", {
			status: 301,
			headers: { location: "ftp://example.com/x" },
		});
	},
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
