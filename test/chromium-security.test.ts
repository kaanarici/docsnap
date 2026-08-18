import { expect, test } from "bun:test";
import { isJsonString } from "../src/core/json.ts";
import type { CdpClient, CdpEvent, JsonObject } from "../src/render/cdp.ts";
import { ChromiumRenderer } from "../src/render/chromium.ts";
import { okFetch, setTestEnv, testConfig } from "./fixtures.ts";

type Call = {
	method: string;
	params: JsonObject;
	sessionId?: string;
};

class FakeCdp implements CdpClient {
	launchMs = 1;
	closed = false;
	onEvent: ((event: CdpEvent) => Promise<void>) | undefined;
	readonly calls: Call[] = [];
	private childConfigured: Promise<void> | undefined;
	private emittedChild = false;

	constructor(private readonly renderedUrl?: string) {}

	async send(
		method: string,
		params: JsonObject = {},
		sessionId?: string,
	): Promise<JsonObject> {
		this.calls.push(
			sessionId ? { method, params, sessionId } : { method, params },
		);
		if (method === "Target.createBrowserContext")
			return { browserContextId: "context" };
		if (method === "Target.createTarget") return { targetId: "main" };
		if (method === "Target.attachToTarget") return { sessionId: "main" };
		if (
			method === "Target.setAutoAttach" &&
			sessionId === "main" &&
			!this.emittedChild
		) {
			this.emittedChild = true;
			this.childConfigured = this.onEvent?.({
				method: "Target.attachedToTarget",
				sessionId: "main",
				params: {
					sessionId: "worker",
					waitingForDebugger: true,
					targetInfo: { targetId: "worker-target", type: "worker" },
				},
			});
		}
		if (method === "Page.navigate") {
			await this.childConfigured;
			if (!this.renderedUrl) throw new Error("stop after target configuration");
		}
		if (method === "Runtime.evaluate" && this.renderedUrl) {
			const expression = params["expression"];
			if (!isJsonString(expression)) return {};
			if (expression.includes("pendingFrames"))
				return { result: { value: [true, 120, 1, false, 1, 0] } };
			if (expression.includes("TextEncoder")) {
				const body = `<html><body><main>${"Rendered docs ".repeat(10)}</main></body></html>`;
				return {
					result: { value: [body, this.renderedUrl, body.length, ""] },
				};
			}
		}
		return {};
	}

	async close() {
		this.closed = true;
	}
}

test("cleans up before restoring default signal termination", async () => {
	const before = new Set(process.listeners("SIGTERM"));
	const cdp = new FakeCdp();
	const renderer = new ChromiumRenderer(cdp, testConfig("unused"));
	try {
		const handler = process
			.listeners("SIGTERM")
			.find((listener) => !before.has(listener));
		expect(handler).toBeDefined();

		const killDescriptor = Object.getOwnPropertyDescriptor(process, "kill");
		if (!killDescriptor) throw new Error("process.kill descriptor unavailable");
		let raised: NodeJS.Signals | undefined;
		let cleanedBeforeRaise = false;
		const { promise: reraised, resolve: resolveRaised } =
			Promise.withResolvers<void>();
		Object.defineProperty(process, "kill", {
			configurable: true,
			writable: true,
			value: (_pid: number, signal?: NodeJS.Signals | number) => {
				raised = signal === "SIGTERM" ? signal : undefined;
				cleanedBeforeRaise = cdp.closed;
				resolveRaised();
				return true;
			},
		});
		try {
			handler?.("SIGTERM");
			await reraised;
			expect(raised).toBe("SIGTERM");
			expect(cleanedBeforeRaise).toBe(true);
		} finally {
			Object.defineProperty(process, "kill", killDescriptor);
		}
	} finally {
		await renderer.close();
	}
});

test("blocks secondary target networking before it resumes", async () => {
	const cdp = new FakeCdp();
	const renderer = new ChromiumRenderer(
		cdp,
		testConfig("unused", { timeoutMs: 250 }),
	);
	try {
		const result = await renderer.renderPage(
			okFetch(
				"https://docs.example.com/guide",
				"<html><body><main>Loading documentation</main></body></html>",
			),
		);
		expect(result.ok).toBe(false);
		const childCalls = cdp.calls.filter((call) => call.sessionId === "worker");
		const methods = childCalls.map((call) => call.method);
		expect(methods).toEqual(
			expect.arrayContaining([
				"Network.setBlockedURLs",
				"Target.setAutoAttach",
				"Runtime.evaluate",
				"Runtime.runIfWaitingForDebugger",
			]),
		);
		expect(methods).not.toContain("Fetch.enable");
		const blocked = childCalls.find(
			(call) => call.method === "Network.setBlockedURLs",
		);
		expect(blocked?.params["urls"]).toEqual(
			expect.arrayContaining(["http://*", "https://*"]),
		);
		expect(methods.indexOf("Network.setBlockedURLs")).toBeLessThan(
			methods.indexOf("Runtime.runIfWaitingForDebugger"),
		);
	} finally {
		await renderer.close();
	}
});

test("bypasses final-document robots only for an explicit seed", async () => {
	let robotsHits = 0;
	const server = Bun.serve({
		port: 0,
		fetch(request) {
			if (new URL(request.url).pathname === "/robots.txt") robotsHits++;
			return new Response("User-agent: *\nDisallow: /\n");
		},
	});
	const origin = `http://127.0.0.1:${server.port}`;
	setTestEnv("DOCSNAP_ALLOW_TEST_HOST", origin);
	const config = testConfig("unused", {
		seedUrl: `${origin}/guide`,
		timeoutMs: 2_000,
	});
	try {
		const seedRenderer = new ChromiumRenderer(
			new FakeCdp(`${origin}/guide`),
			config,
		);
		try {
			const result = await seedRenderer.renderPage(
				okFetch(`${origin}/guide`, "<main>Loading</main>"),
				{ explicitSeed: true },
			);
			expect(result.ok).toBe(true);
			expect(robotsHits).toBe(0);
		} finally {
			await seedRenderer.close();
		}

		const discoveredRenderer = new ChromiumRenderer(
			new FakeCdp(`${origin}/private`),
			config,
		);
		try {
			const result = await discoveredRenderer.renderPage(
				okFetch(`${origin}/private`, "<main>Loading</main>"),
			);
			expect(result).toMatchObject({
				ok: false,
				error: "Rendered page ended at a robots-disallowed URL",
			});
			expect(robotsHits).toBe(1);
		} finally {
			await discoveredRenderer.close();
		}
	} finally {
		server.stop(true);
	}
});

test("stores the rendered final URL without userinfo or hash", async () => {
	const cdp = new FakeCdp("https://user:secret@docs.example.com/guide#section");
	const renderer = new ChromiumRenderer(cdp, testConfig("unused"));
	try {
		const result = await renderer.renderPage(
			okFetch(
				"https://docs.example.com/guide",
				"<html><body><main>Loading documentation</main></body></html>",
			),
			{ explicitSeed: true },
		);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.result.finalUrl).toBe("https://docs.example.com/guide");
	} finally {
		await renderer.close();
	}
});

test("rejects a rendered final URL that is not public HTTP", async () => {
	const cdp = new FakeCdp("http://127.0.0.1/guide");
	const renderer = new ChromiumRenderer(cdp, testConfig("unused"));
	try {
		const result = await renderer.renderPage(
			okFetch(
				"https://docs.example.com/guide",
				"<html><body><main>Loading documentation</main></body></html>",
			),
			{ explicitSeed: true },
		);
		expect(result).toMatchObject({
			ok: false,
			error: "Rendered page ended at an unsafe URL",
		});
	} finally {
		await renderer.close();
	}
});

test("labels rendered HTTP error documents with an explicit FailureKind", async () => {
	const cdp = new FakeCdp("https://docs.example.com/missing");
	const renderer = new ChromiumRenderer(cdp, testConfig("unused"));
	try {
		const result = await renderer.renderPage(
			okFetch(
				"https://docs.example.com/missing",
				"<html><body><main>Missing</main></body></html>",
				{ status: 404 },
			),
			{ explicitSeed: true },
		);
		expect(result).toMatchObject({
			ok: true,
			result: {
				ok: false,
				status: 404,
				failureKind: "not_found",
				error: "HTTP 404",
			},
		});
	} finally {
		await renderer.close();
	}
});
