import { describe, expect, onTestFinished, test } from "bun:test";
import { once } from "node:events";
import {
	createServer,
	type IncomingMessage,
	type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import type { FailureKind } from "../src/core/types.ts";
import { fetchTextUncached } from "../src/fetch/fetcher.ts";
import { failed, failureKind } from "../src/fetch/result.ts";
import { thrownFetchKind } from "../src/fetch/retry.ts";
import { setTestEnv, testConfig } from "./fixtures.ts";

const allowHostEnv = "DOCSNAP_ALLOW_TEST_HOST";

describe("FailureKind assignment", () => {
	test.each([
		[404, "not_found"],
		[410, "not_found"],
		[401, "blocked"],
		[403, "blocked"],
		[400, "http"],
	] as const)("maps HTTP %i to %s", async (status, kind) => {
		const origin = serve(() => new Response("nope", { status }));
		await expectKind(`${origin}/page`, kind, { status });
	});

	test("keeps a robots-denied markdown fallback blocked over the original 404", async () => {
		const origin = serve(() => new Response("missing", { status: 404 }));
		const result = await fetchTextUncached(
			`${origin}/page.md`,
			testConfig("unused", { seedUrl: `${origin}/page.md` }),
			"text/markdown",
			undefined,
			() => false,
		);
		expect(result).toMatchObject({
			ok: false,
			status: 404,
			failureKind: "blocked",
			error: "blocked by robots.txt",
		});
	});

	test("labels a client challenge blocked even when the status is 200", async () => {
		const origin = serve(
			() =>
				new Response("challenge", {
					headers: { "x-amzn-waf-action": "challenge" },
				}),
		);
		await expectKind(origin, "blocked");
	});

	test("labels a chunked body over the budget too_large", async () => {
		const origin = await serveHttp((_request, response) => {
			response.writeHead(200, {
				"content-type": "text/plain",
				"transfer-encoding": "chunked",
			});
			response.end("x".repeat(4096));
		});
		await expectKind(origin, "too_large", { maxBytes: 64 });
	});

	test("labels an unsupported redirect scheme unsafe_url", async () => {
		const origin = serve(
			() =>
				new Response(null, {
					status: 302,
					headers: { location: "file:///etc/passwd" },
				}),
		);
		await expectKind(origin, "unsafe_url");
	});

	test("labels a redirect loop http", async () => {
		const origin = serve(
			() =>
				new Response(null, {
					status: 302,
					headers: { location: "/loop" },
				}),
		);
		await expectKind(`${origin}/loop`, "http", { status: 302 });
	});

	test("labels a hung request timeout", async () => {
		const origin = await serveHttp(() => {});
		await expectKind(origin, "timeout", { timeoutMs: 50 });
	});

	test("labels a refused connection fetch", async () => {
		await expectKind(closedOrigin(), "fetch");
	});
});

describe("chromium status helper", () => {
	test.each([
		[404, "HTTP 404", "not_found"],
		[410, "HTTP 410", "not_found"],
		[401, "HTTP 401", "blocked"],
		[403, "HTTP 403", "blocked"],
		[429, "HTTP 429", "blocked"],
		[500, "HTTP 500", "http"],
		[0, "HTTP 0", "fetch"],
	] as const)("maps %i without sniffing %s", (status, _error, kind) => {
		expect(failureKind(status)).toBe(kind);
	});

	test("does not classify from the error string", () => {
		expect(failureKind(404)).toBe("not_found");
		expect(failureKind(0)).toBe("fetch");
		expect(failureKind(200)).toBe("http");
	});
});

describe("thrown fetch kind", () => {
	test("maps timeout, size, unsafe, and generic causes", () => {
		expect(thrownFetchKind(new Error("request timed out"))).toBe("timeout");
		const timeout = new Error("deadline reached");
		timeout.name = "TimeoutError";
		expect(thrownFetchKind(timeout)).toBe("timeout");
		expect(thrownFetchKind(new Error("response exceeds 12 bytes"))).toBe(
			"too_large",
		);
		expect(thrownFetchKind(new Error("buffer larger than 12 bytes"))).toBe(
			"too_large",
		);
		expect(
			thrownFetchKind(
				new Error("private or internal IP addresses are not allowed"),
			),
		).toBe("unsafe_url");
		expect(thrownFetchKind(new Error("ECONNREFUSED"))).toBe("fetch");
	});
});

test("failed records the caller kind instead of sniffing the error", () => {
	expect(
		failed(
			"https://docs.example.com/page.md",
			"https://docs.example.com/page",
			404,
			performance.now(),
			"blocked by robots.txt",
			"blocked",
		),
	).toMatchObject({
		ok: false,
		status: 404,
		failureKind: "blocked",
	});
});

async function expectKind(
	url: string,
	kind: FailureKind,
	overrides: {
		status?: number;
		maxBytes?: number;
		timeoutMs?: number;
	} = {},
) {
	const result = await fetchTextUncached(
		url,
		testConfig("unused", {
			seedUrl: url,
			maxBytes: overrides.maxBytes ?? 1024 * 1024,
			timeoutMs: overrides.timeoutMs ?? 1_000,
		}),
		"text/html",
	);
	expect(result.ok).toBe(false);
	if (result.ok) return;
	expect(result.failureKind).toBe(kind);
	if (overrides.status !== undefined) {
		expect(result.status).toBe(overrides.status);
	}
}

function serve(fetch: (request: Request) => Response | Promise<Response>) {
	const server = Bun.serve({ port: 0, fetch });
	onTestFinished(() => server.stop(true));
	const origin = `http://127.0.0.1:${server.port}`;
	setTestEnv(allowHostEnv, origin);
	return origin;
}

function closedOrigin() {
	const server = Bun.serve({
		port: 0,
		fetch: () => new Response("unused"),
	});
	const origin = `http://127.0.0.1:${server.port}`;
	server.stop(true);
	setTestEnv(allowHostEnv, origin);
	return origin;
}

async function serveHttp(
	handler: (request: IncomingMessage, response: ServerResponse) => void,
) {
	const server = createServer(handler);
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	onTestFinished(async () => {
		server.closeAllConnections();
		const stopped = once(server, "close");
		server.close();
		await stopped;
	});
	const address = server.address();
	if (!address || isSocketPath(address)) {
		throw new Error("missing test server address");
	}
	const origin = `http://127.0.0.1:${address.port}`;
	setTestEnv(allowHostEnv, origin);
	return origin;
}

function isSocketPath(address: string | AddressInfo): address is string {
	return typeof address === "string";
}
