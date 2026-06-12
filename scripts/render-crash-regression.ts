import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { parseArgs } from "../src/cli/args.ts";
import { runPipeline } from "../src/core/pipeline.ts";
import type { Config, PageRecord } from "../src/core/types.ts";
import { setFetchTransportForTest } from "../src/fetch/fetcher.ts";
import { type BrowserSession, launchBrowser } from "../src/render/browser.ts";
import { CdpConnection } from "../src/render/cdp.ts";
import { setBrowserLauncherForTest } from "../src/render/index.ts";

const testOrigin = "http://127.0.0.1:17777";

await import("./render-launch-regression.ts");
await launchFailureFallbackRegression();
await transientLaunchRetryRegression();
await midRenderCrashFallbackRegression();

async function launchFailureFallbackRegression() {
	const root = await mkdtemp(join(tmpdir(), "docsnap-launch-profiles-"));
	let attempts = 0;
	const messages: string[] = [];
	const result = await runShellPipeline(
		"docsnap-launch-fail-",
		(binary) =>
			launchBrowser(binary, {
				profileRoot: root,
				retryDelayMs: () => 0,
				launchAttempt: async () => {
					attempts++;
					throw new Error("launch race");
				},
			}),
		(message) => messages.push(message),
	);
	assert(result.summary.render.attempted === 1);
	assert(result.summary.render.failedPages === 1);
	assert(result.summary.render.renderedPages === 0);
	assert(
		result.summary.render.unavailableReason ===
			"browser launch failed: launch race",
	);
	assert(
		result.summary.render.pages[0]?.error ===
			"browser_crash: browser launch failed: launch race",
	);
	assert(result.summary.written > 0);
	assert(attempts === 3);
	assert(
		messages.filter((item) => item.includes("render unavailable")).length === 1,
	);
	await assertNoEntries(root);
}

async function transientLaunchRetryRegression() {
	const root = await mkdtemp(join(tmpdir(), "docsnap-retry-profiles-"));
	let attempts = 0;
	let closed = 0;
	const result = await runShellPipeline("docsnap-retry-ok-", (binary) =>
		launchBrowser(binary, {
			profileRoot: root,
			retryDelayMs: () => 0,
			launchAttempt: async () => {
				attempts++;
				if (attempts === 1) throw new Error("transient launch race");
				return fakeBrowserSession({
					close: () => {
						closed++;
					},
				});
			},
		}),
	);
	assert(result.summary.render.attempted === 1);
	assert(result.summary.render.failedPages === 0);
	assert(result.summary.render.renderedPages === 1);
	assert(result.summary.render.pages.length === 1);
	assert(result.summary.bySource.render === 1);
	assert(attempts === 2);
	assert(closed === 1);
	await assertNoEntries(root);
}

async function midRenderCrashFallbackRegression() {
	const root = await mkdtemp(join(tmpdir(), "docsnap-crash-profiles-"));
	let closed = 0;
	const result = await runShellPipeline("docsnap-render-crash-", (binary) =>
		launchBrowser(binary, {
			profileRoot: root,
			retryDelayMs: () => 0,
			launchAttempt: async () =>
				fakeBrowserSession({
					crashOnNavigate: true,
					close: () => {
						closed++;
					},
				}),
		}),
	);
	assert(result.summary.render.attempted === 1);
	assert(result.summary.render.failedPages === 1);
	assert(result.summary.render.renderedPages === 0);
	assert(
		result.summary.render.pages[0]?.error ===
			"browser_crash: CDP connection closed",
	);
	assert(result.summary.written > 0);
	const record = result.records.find((item: PageRecord) => item.ok);
	assert(record?.source === "seed");
	assert(record.markdown.includes("Static fallback content"));
	assert(record.render?.error === "browser_crash: CDP connection closed");
	assert(closed === 1);
	await assertNoEntries(root);
}

async function runShellPipeline(
	fixturePrefix: string,
	launchThunk: BrowserLauncher,
	onProgress?: (message: string) => void,
) {
	const outDir = await mkdtemp(join(tmpdir(), fixturePrefix));
	return withEnv(
		{
			DOCSNAP_ALLOW_TEST_HOST: testOrigin,
			DOCSNAP_CHROME_PATH: process.execPath,
		},
		() =>
			withHooks({ transport: shellTransport, launcher: launchThunk }, () =>
				runPipeline(shellConfig(outDir), onProgress),
			),
	);
}

function fakeBrowserSession(
	options: { close?: () => void; crashOnNavigate?: boolean } = {},
): BrowserSession {
	const toBrowser = new PassThrough();
	const fromBrowser = new PassThrough();
	const cdp = new CdpConnection(toBrowser, fromBrowser);
	let buffer = "";
	let currentUrl = `${testOrigin}/`;
	let closed = false;

	toBrowser.on("data", (chunk: Buffer) => {
		buffer += chunk.toString("utf8");
		let zero = buffer.indexOf("\0");
		while (zero >= 0) {
			const raw = buffer.slice(0, zero);
			buffer = buffer.slice(zero + 1);
			zero = buffer.indexOf("\0");
			if (raw) handleCommand(JSON.parse(raw) as CdpCommand);
		}
	});

	function handleCommand(command: CdpCommand) {
		if (command.method === "Target.createTarget")
			return respond(command.id, { targetId: "target-1" });
		if (command.method === "Target.attachToTarget")
			return respond(command.id, { sessionId: "session-1" });
		if (command.method === "Page.navigate") {
			if (options.crashOnNavigate) {
				cdp.close(new Error("CDP connection closed"));
				return;
			}
			currentUrl = String(command.params?.url ?? currentUrl);
			return respond(command.id, {});
		}
		if (command.method === "Runtime.evaluate") {
			const expression = String(command.params?.expression ?? "");
			const value =
				expression === "document.readyState"
					? "complete"
					: expression === "location.href"
						? currentUrl
						: renderedHtml(currentUrl);
			return respond(command.id, { result: { value } });
		}
		respond(command.id, {});
	}

	function respond(id: number, result: unknown) {
		fromBrowser.write(`${JSON.stringify({ id, result })}\0`);
	}

	return {
		cdp,
		binary: { path: process.execPath, name: "chrome" },
		product: "mock-chrome",
		close: async () => {
			if (closed) return;
			closed = true;
			options.close?.();
			cdp.close();
			toBrowser.destroy();
			fromBrowser.destroy();
		},
	};
}

type BrowserLauncher = NonNullable<
	Parameters<typeof setBrowserLauncherForTest>[0]
>;

type CdpCommand = {
	id: number;
	method: string;
	params?: {
		expression?: unknown;
		url?: unknown;
	};
};

type HookOverrides = {
	transport?: Parameters<typeof setFetchTransportForTest>[0];
	launcher?: Parameters<typeof setBrowserLauncherForTest>[0];
};

async function withHooks<T>(hooks: HookOverrides, fn: () => Promise<T>) {
	setFetchTransportForTest(hooks.transport);
	setBrowserLauncherForTest(hooks.launcher);
	try {
		return await fn();
	} finally {
		setFetchTransportForTest(undefined);
		setBrowserLauncherForTest(undefined);
	}
}

async function withEnv<T>(
	values: Record<string, string>,
	fn: () => Promise<T>,
) {
	const previous = new Map(
		Object.keys(values).map((key) => [key, process.env[key]]),
	);
	for (const [key, value] of Object.entries(values)) process.env[key] = value;
	try {
		return await fn();
	} finally {
		for (const [key, value] of previous) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
}

function shellConfig(outDir: string): Config {
	const config = parseArgs([
		`${testOrigin}/`,
		"-m",
		"1",
		"-o",
		outDir,
		"--clean",
		"--quiet",
		"--ignore-robots",
		"--no-cache",
	]);
	assert(!("help" in config) && !("version" in config));
	return config;
}

async function shellTransport(input: string | URL | Request) {
	const url = String(input);
	if (
		url.endsWith("/llms.txt") ||
		url.endsWith("/robots.txt") ||
		url.endsWith("/app.js")
	) {
		return response(url, 404, "not found", "text/plain");
	}
	return response(url, 200, staticShellHtml());
}

function staticShellHtml() {
	return `<html><head><title>Static Docs</title></head><body><main><h1>Static Docs</h1><p>Static fallback content stays available when browser rendering fails during launch or navigation.</p></main><div id="app"></div><script src="/app.js"></script></body></html>`;
}

function renderedHtml(base: string) {
	return `<html><head><title>Rendered Docs</title></head><body><main><h1>Rendered Docs</h1><p>Rendered documentation content with enough useful words for extraction and scoring after client-side JavaScript runs.</p><p>This page proves docsnap routes rendered HTML back through the normal extractor and markdown quality path.</p><a href="${new URL("/next", base).href}">Next</a></main></body></html>`;
}

function response(
	url: string,
	status: number,
	body: string,
	contentType = "text/html",
) {
	return {
		url,
		status,
		headers: {
			get: (name: string) =>
				name.toLowerCase() === "content-type" ? contentType : null,
			getSetCookie: () => [],
		},
		body: new TextEncoder().encode(body),
	};
}

async function assertNoEntries(root: string) {
	const entries = await readdir(root);
	assert(entries.length === 0);
}

function assert(condition: unknown): asserts condition {
	if (!condition) throw new Error("assertion failed");
}
