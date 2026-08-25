import { expect, test } from "bun:test";
import type { JsonObject } from "../src/core/json.ts";
import { type BrowserView, ChromiumRenderer } from "../src/render/chromium.ts";
import { okFetch, setTestEnv, testConfig } from "./fixtures.ts";

type Call = {
	method: string;
	params: JsonObject;
};

class FakeView implements BrowserView {
	closed = false;
	readonly calls: Call[] = [];

	constructor(private readonly renderedUrl?: string) {}

	async cdp(method: string, params: JsonObject = {}) {
		this.calls.push({ method, params });
		return {};
	}

	async evaluate(expression: string) {
		if (!this.renderedUrl) throw new Error("render unavailable");
		if (expression.includes("pendingFrames"))
			return [true, 120, 1, false, 1, 0];
		const body = `<html><body><main>${"Rendered docs ".repeat(10)}</main></body></html>`;
		return [body, this.renderedUrl, body.length, ""];
	}

	async navigate(url: string) {
		this.calls.push({ method: "navigate", params: { url } });
		if (url !== "about:blank" && !this.renderedUrl)
			throw new Error("render unavailable");
	}

	addEventListener(
		_type: `${string}.${string}`,
		_listener: (event: { data: JsonObject }) => void,
	) {}

	close() {
		this.closed = true;
	}
}

test("cleans up before restoring default signal termination", async () => {
	const before = new Set(process.listeners("SIGTERM"));
	const view = new FakeView();
	const renderer = new ChromiumRenderer(view, testConfig("unused"));
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
				cleanedBeforeRaise = view.closed;
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

test("intercepts browser networking before navigation", async () => {
	const view = new FakeView();
	const renderer = new ChromiumRenderer(
		view,
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
		const methods = view.calls.map((call) => call.method);
		expect(methods).toEqual(
			expect.arrayContaining([
				"Network.setBlockedURLs",
				"Network.setBypassServiceWorker",
				"Fetch.enable",
				"Browser.setDownloadBehavior",
				"Network.clearBrowserCookies",
			]),
		);
		const blocked = view.calls.find(
			(call) => call.method === "Network.setBlockedURLs",
		);
		expect(blocked?.params["urls"]).toEqual([
			"ws://*",
			"wss://*",
			"file://*",
			"ftp://*",
		]);
		expect(methods.indexOf("Fetch.enable")).toBeLessThan(
			methods.indexOf("navigate"),
		);
	} finally {
		await renderer.close();
	}
});

test("clears browser state before reusing the view", async () => {
	const url = "https://docs.example.com/guide";
	const view = new FakeView(url);
	const renderer = new ChromiumRenderer(view, testConfig("unused"));
	try {
		for (let attempt = 0; attempt < 2; attempt++) {
			const result = await renderer.renderPage(
				okFetch(url, "<main>Loading documentation</main>"),
				{ explicitSeed: true },
			);
			expect(result.ok).toBe(true);
		}
		const calls = view.calls.filter(
			(call) => call.method === "Storage.clearDataForOrigin",
		);
		expect(calls).toHaveLength(1);
		expect(calls[0]?.params).toEqual({
			origin: "https://docs.example.com",
			storageTypes: "all",
		});
		expect(
			view.calls.filter(
				(call) =>
					call.method === "Emulation.setVirtualTimePolicy" &&
					call.params["policy"] === "advance",
			),
		).toHaveLength(2);
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
			new FakeView(`${origin}/guide`),
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
			new FakeView(`${origin}/private`),
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
	const view = new FakeView(
		"https://user:secret@docs.example.com/guide#section",
	);
	const renderer = new ChromiumRenderer(view, testConfig("unused"));
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
	const view = new FakeView("http://127.0.0.1/guide");
	const renderer = new ChromiumRenderer(view, testConfig("unused"));
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
	const view = new FakeView("https://docs.example.com/missing");
	const renderer = new ChromiumRenderer(view, testConfig("unused"));
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
