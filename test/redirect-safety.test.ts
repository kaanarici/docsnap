import { afterEach, describe, expect, test } from "bun:test";
import { fetchTextUncached } from "../src/fetch/fetcher.ts";
import { testConfig } from "./fixtures.ts";

const allowHostEnv = "DOCSNAP_ALLOW_TEST_HOST";
const priorAllowHost = process.env[allowHostEnv];

afterEach(() => {
	if (priorAllowHost === undefined) delete process.env[allowHostEnv];
	else process.env[allowHostEnv] = priorAllowHost;
});

describe("redirect target safety", () => {
	test.each([
		{
			path: "/http",
			response: () =>
				new Response(null, {
					status: 302,
					headers: { location: "http://127.0.0.1:1/private" },
				}),
		},
		{
			path: "/refresh",
			response: () =>
				new Response(
					'<meta http-equiv="refresh" content="0;url=http://127.0.0.1:1/private">',
					{ headers: { "content-type": "text/html" } },
				),
		},
	])("revalidates $path redirects before connecting", async ({
		path,
		response,
	}) => {
		const server = Bun.serve({
			port: 0,
			fetch: () => response(),
		});
		const origin = `http://127.0.0.1:${server.port}`;
		process.env[allowHostEnv] = origin;
		try {
			const result = await fetchTextUncached(
				`${origin}${path}`,
				testConfig("unused", {
					seedUrl: `${origin}${path}`,
					timeoutMs: 500,
				}),
				"text/html",
			);
			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.failureKind).toBe("unsafe_url");
				expect(result.error).toContain("private");
			}
		} finally {
			server.stop(true);
		}
	});
});
