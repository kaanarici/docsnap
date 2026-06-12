import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findBrowserBinary } from "../src/render/browser.ts";

if (env("DOCSNAP_RENDER_SMOKE") !== "1") {
	console.log("render smoke skipped: set DOCSNAP_RENDER_SMOKE=1");
	process.exit(0);
}
if (env("CODEX_SANDBOX_NETWORK_DISABLED") === "1") {
	console.log("render smoke skipped: local networking disabled by sandbox");
	process.exit(0);
}

const browser = await findBrowserBinary();
if (!browser) {
	console.log("render smoke skipped: no Chrome/Chromium/Edge binary found");
	process.exit(0);
}

const outRoot = await mkdtemp(join(tmpdir(), "docsnap-render-smoke-"));
const outDir = join(outRoot, "capture");
const server = await startServer((request) => {
	const url = new URL(request.url);
	if (url.pathname === "/robots.txt") {
		return text("User-agent: *\nAllow: /\n", "text/plain");
	}
	if (url.pathname === "/app.js") {
		return text(
			`document.getElementById("app").innerHTML = "<main><h1>Rendered SPA Docs</h1><p>Real browser smoke content rendered by JavaScript with enough stable prose for extraction.</p><p>The renderer must capture this text from document.documentElement.outerHTML.</p></main>";`,
			"text/javascript",
		);
	}
	return text(
		`<!doctype html><html><head><title>SPA Docs</title></head><body><div id="app"></div><script src="/app.js"></script></body></html>`,
		"text/html; charset=utf-8",
	);
});
const origin = `http://127.0.0.1:${server.port}`;

try {
	const subprocess = Bun.spawn({
		cmd: [
			"bun",
			"bin/docsnap",
			`${origin}/`,
			"--page",
			"--render",
			"auto",
			"--json",
			"--quiet",
			"--clean",
			"-o",
			outDir,
		],
		cwd: process.cwd(),
		env: {
			...process.env,
			DOCSNAP_ALLOW_TEST_HOST: origin,
			DOCSNAP_CHROME_PATH: browser.path,
		},
		stdout: "pipe",
		stderr: "pipe",
	});
	const [exitCode, stdout, stderr] = await Promise.all([
		subprocess.exited,
		new Response(subprocess.stdout).text(),
		new Response(subprocess.stderr).text(),
	]);
	assert(exitCode === 0, stderr || stdout);
	const result = JSON.parse(stdout.trim()) as { paths?: { summary?: string } };
	assert(result.paths?.summary, stdout);
	const summary = JSON.parse(await readFile(result.paths.summary, "utf8"));
	assert(summary.render.renderedPages > 0, JSON.stringify(summary.render));
	const manifest = await readFile(join(outDir, "manifest.jsonl"), "utf8");
	assert(manifest.includes('"source":"render"'), manifest);
	console.log(
		`render smoke passed: ${summary.render.renderedPages} rendered page(s) with ${summary.render.browser}`,
	);
} finally {
	await server.stop();
	await rm(outRoot, { recursive: true, force: true });
}

function text(body: string, contentType: string, status = 200) {
	return new Response(body, {
		status,
		headers: { "content-type": contentType },
	});
}

type TestServer = {
	port: number;
	stop(): Promise<void>;
};

async function startServer(
	fetch: (request: Request) => Response,
): Promise<TestServer> {
	let port = 0;
	const server = createServer(async (request, response) => {
		const result = fetch(
			new Request(`http://127.0.0.1:${port}${request.url ?? "/"}`),
		);
		response.writeHead(result.status, Object.fromEntries(result.headers));
		response.end(await result.text());
	});
	const error = await listen(server);
	if (error) throw error;
	const address = server.address() as AddressInfo | null;
	assert(address?.port, "server did not bind to a TCP port");
	port = address.port;
	return {
		port,
		stop: () => new Promise((resolve) => server.close(() => resolve())),
	};
}

function listen(server: ReturnType<typeof createServer>) {
	return new Promise<unknown>((resolve) => {
		server.once("error", resolve);
		try {
			server.listen(0, "127.0.0.1", () => resolve(undefined));
		} catch (error) {
			resolve(error);
		}
	});
}

function assert(
	condition: unknown,
	message = "assertion failed",
): asserts condition {
	if (!condition) throw new Error(message);
}

function env(key: string) {
	return process.env[key];
}
