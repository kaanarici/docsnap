import { describe, expect, test } from "bun:test";
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { freshUntilFor } from "../src/cache/policy.ts";
import {
	type Cookie,
	cookieHeader,
	storeCookies,
} from "../src/fetch/cookies.ts";
import { fetchTextUncached } from "../src/fetch/fetcher.ts";
import { requestPublicHttp } from "../src/fetch/transport.ts";
import { setTestEnv, testConfig } from "./fixtures.ts";

const allowHostEnv = "DOCSNAP_ALLOW_TEST_HOST";

test("keeps response cookies on the exact host", () => {
	const cookies: Cookie[] = [];
	storeCookies(cookies, "https://attacker.com.tr/start", {
		url: "https://attacker.com.tr/start",
		status: 200,
		headers: new Headers({
			"set-cookie": "choice=attacker; Domain=com.tr; Secure",
		}),
		body: new Uint8Array(),
	});
	expect(cookieHeader(cookies, "https://attacker.com.tr/next")).toBe(
		"choice=attacker",
	);
	expect(cookieHeader(cookies, "https://victim.com.tr/")).toBe("");
	expect(cookieHeader(cookies, "http://attacker.com.tr/")).toBe("");
	storeCookies(cookies, "https://attacker.com.tr/private/start", {
		url: "https://attacker.com.tr/private/start",
		status: 200,
		headers: new Headers({ "set-cookie": "session=private; Path=/private" }),
		body: new Uint8Array(),
	});
	expect(cookieHeader(cookies, "https://attacker.com.tr/public")).toBe(
		"choice=attacker",
	);
	expect(cookieHeader(cookies, "https://attacker.com.tr/private/next")).toBe(
		"session=private; choice=attacker",
	);
});

describe("redirect target safety", () => {
	test("does not cache a final response personalized by a redirect cookie", async () => {
		const server = Bun.serve({
			port: 0,
			fetch: (request) =>
				new URL(request.url).pathname === "/start"
					? new Response(null, {
							status: 302,
							headers: {
								location: "/docs",
								"set-cookie": "variant=secret",
							},
						})
					: new Response(
							request.headers.get("cookie") === "variant=secret"
								? "personalized docs"
								: "public docs",
							{ headers: { "cache-control": "public, max-age=3600" } },
						),
		});
		const origin = `http://127.0.0.1:${server.port}`;
		setTestEnv(allowHostEnv, origin);
		try {
			const result = await fetchTextUncached(
				`${origin}/start`,
				testConfig("unused", { seedUrl: `${origin}/start` }),
				"text/html",
			);
			expect(result.body).toBe("personalized docs");
			expect(result.setCookie).toBe(true);
			expect(freshUntilFor(result)).toBeUndefined();
		} finally {
			server.stop(true);
		}
	});

	test("closes redirect bodies instead of draining them in the background", async () => {
		let bodyClosed = () => {};
		const closed = new Promise<void>((resolve) => {
			bodyClosed = resolve;
		});
		const server = createServer((request, response) => {
			const timer = setInterval(() => response.write("redirect body\n"), 5);
			timer.unref();
			request.socket.on("close", () => {
				clearInterval(timer);
				bodyClosed();
			});
			response.writeHead(302, { location: "/next" });
			response.write("redirect body\n");
		});
		server.listen(0, "127.0.0.1");
		await once(server, "listening");
		const address = server.address();
		if (!address || isSocketPath(address))
			throw new Error("missing test server address");
		const { port } = address;
		const origin = `http://127.0.0.1:${port}`;
		setTestEnv(allowHostEnv, origin);
		try {
			const response = await requestPublicHttp(
				`${origin}/redirect`,
				{ accept: "*/*", "user-agent": "docsnap-test" },
				testConfig("unused", { seedUrl: `${origin}/redirect` }),
			);
			expect(response.status).toBe(302);
			expect(
				await Promise.race([
					closed.then(() => true),
					Bun.sleep(500).then(() => false),
				]),
			).toBe(true);
		} finally {
			server.closeAllConnections();
			const stopped = once(server, "close");
			server.close();
			await stopped;
		}
	});

	test("revalidates HTTP and refresh redirects before connecting", async () => {
		const server = Bun.serve({
			port: 0,
			fetch: (request) =>
				new URL(request.url).pathname === "/http"
					? new Response(null, {
							status: 302,
							headers: { location: "http://127.0.0.1:1/private" },
						})
					: new Response(
							'<meta http-equiv="refresh" content="0;url=http://127.0.0.1:1/private">',
							{ headers: { "content-type": "text/html" } },
						),
		});
		const origin = `http://127.0.0.1:${server.port}`;
		setTestEnv(allowHostEnv, origin);
		try {
			for (const path of ["/http", "/refresh"]) {
				const result = await fetchTextUncached(
					`${origin}${path}`,
					testConfig("unused", {
						seedUrl: `${origin}${path}`,
						timeoutMs: 500,
					}),
					"text/html",
					undefined,
					(url) => new URL(url).origin === origin,
				);
				expect(result).toMatchObject({
					ok: false,
					failureKind: "unsafe_url",
				});
				if (!result.ok) expect(result.error).toContain("private");
			}
		} finally {
			server.stop(true);
		}
	});
});

function isSocketPath(address: string | AddressInfo): address is string {
	return typeof address === "string";
}
