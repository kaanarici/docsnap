import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

type CliResult = {
	ok: boolean;
	written: number;
	failed: number;
	outDir: string;
	paths?: {
		summary: string;
		manifest: string;
		agentReadme: string;
		tree: string;
	};
};

type Summary = {
	written: number;
	failed: number;
	byFailureKind: { not_found?: number } & Record<string, number | undefined>;
	errors: Array<{ url: string; error: string; kind: string }>;
};

type ManifestRecord = {
	ok: boolean;
	url: string;
	outputPath?: string;
	failureKind?: string;
};

const fixtureText =
	"Hermetic CLI fixture text proves the real docsnap binary fetched local docs.";
const { CODEX_SANDBOX_NETWORK_DISABLED } = process.env;
if (CODEX_SANDBOX_NETWORK_DISABLED === "1") process.exit(0);

const pages: Record<string, string> = {
	"/": page(
		"Fixture Home",
		`<p>${fixtureText} The home page links to the core guide, intro, reference page, and one intentionally missing page.</p>
		<nav>
			<a href="/intro">Intro</a>
			<a href="/guide">Guide</a>
			<a href="/reference">Reference</a>
			<a href="/missing">Missing</a>
		</nav>`,
	),
	"/intro": page(
		"Fixture Intro",
		`<p>${fixtureText} The intro explains installation, setup, verification, and how a small documentation site should be captured.</p>
		<p>It has enough stable prose for extraction without relying on any public network or mocked transport.</p>`,
	),
	"/guide": page(
		"Fixture Guide",
		`<p>${fixtureText} The guide covers repeated usage, navigation, output files, and summary inspection for coding agents.</p>
		<p>Every sentence is deterministic so the regression can assert the generated Markdown body.</p>`,
	),
	"/reference": page(
		"Fixture Reference",
		`<p>${fixtureText} The reference page lists summary.json, manifest.jsonl, tree.txt, AGENT_README.md, and Markdown pages.</p>
		<p>This page helps prove multiple local links can be discovered and fetched through the real CLI binary.</p>`,
	),
};
const tmpRoot = await mkdtemp(join(tmpdir(), "docsnap-cli-"));
const outDir = join(tmpRoot, "capture");
let origin = "";
let server: TestServer | undefined;

try {
	server = await startServer((request) => fixtureResponse(request));
	if (server) {
		origin = `http://127.0.0.1:${server.port}`;
		const result = await runCli(origin, outDir);
		assert(result.ok);
		assert(result.written > 0);
		assert(result.outDir === outDir);
		assert(Boolean(result.paths));

		const [summaryText, manifestText] = await Promise.all([
			readFile(join(outDir, "summary.json"), "utf8"),
			readFile(join(outDir, "manifest.jsonl"), "utf8"),
			readFile(join(outDir, "tree.txt"), "utf8"),
			readFile(join(outDir, "AGENT_README.md"), "utf8"),
		]);
		const summary = JSON.parse(summaryText) as Summary;
		const manifest = manifestText
			.trim()
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line) as ManifestRecord);

		assert(
			summary.written === manifest.filter((record) => record.outputPath).length,
		);
		assert(summary.failed === manifest.filter((record) => !record.ok).length);
		assert(summary.written + summary.failed === manifest.length);
		assert(result.written === summary.written);
		assert(result.failed === summary.failed);

		const missing = manifest.find((record) => record.url.endsWith("/missing"));
		assert(missing?.ok === false);
		assert(missing.failureKind === "not_found");
		assert(summary.byFailureKind.not_found === 1);
		assert(summary.errors.some((error) => error.url.endsWith("/missing")));

		const files = await listFiles(outDir);
		for (const file of [
			"summary.json",
			"manifest.jsonl",
			"tree.txt",
			"AGENT_README.md",
		]) {
			assert(files.includes(file));
		}
		const pageFiles = files.filter(
			(file) => file.endsWith(".md") && file !== "AGENT_README.md",
		);
		assert(pageFiles.length > 0);
		const capturedPage = await readFile(join(outDir, pageFiles[0]!), "utf8");
		assert(capturedPage.includes(fixtureText));
	}
} finally {
	await server?.stop(true);
	await rm(tmpRoot, { recursive: true, force: true });
}

async function runCli(origin: string, output: string): Promise<CliResult> {
	const subprocess = Bun.spawn({
		cmd: [
			"bun",
			"bin/docsnap",
			`${origin}/`,
			"--json",
			"--quiet",
			"-o",
			output,
		],
		cwd: process.cwd(),
		env: { ...cleanEnv(), DOCSNAP_ALLOW_TEST_HOST: origin },
		stdout: "pipe",
		stderr: "pipe",
	});
	const [exitCode, stdout, stderr] = await Promise.all([
		subprocess.exited,
		new Response(subprocess.stdout).text(),
		new Response(subprocess.stderr).text(),
	]);
	assert(exitCode === 0, stderr || stdout);
	assert(stderr.trim() === "", stderr);
	const trimmed = stdout.trim();
	assert(trimmed.split(/\r?\n/).length === 1, stdout);
	const parsed = JSON.parse(trimmed);
	assert(parsed && typeof parsed === "object" && !Array.isArray(parsed));
	return parsed as CliResult;
}

function fixtureResponse(request: Request): Response {
	const url = new URL(request.url);
	if (url.pathname === "/robots.txt") {
		return text(
			`User-agent: *\nAllow: /\nSitemap: ${origin}/sitemap.xml\n`,
			"text/plain",
		);
	}
	if (url.pathname === "/sitemap.xml") {
		return text(
			`<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
	<url><loc>${origin}/intro</loc></url>
	<url><loc>${origin}/guide</loc></url>
	<url><loc>${origin}/reference</loc></url>
	<url><loc>${origin}/missing</loc></url>
</urlset>`,
			"application/xml",
		);
	}
	if (url.pathname === "/llms.txt") return text("not found", "text/plain", 404);
	if (url.pathname === "/missing") {
		return text(
			"<main><h1>Missing</h1><p>Not found.</p></main>",
			"text/html",
			404,
		);
	}
	const body = pages[trimSlash(url.pathname)];
	if (!body) return text("not found", "text/plain", 404);
	return text(body, "text/html; charset=utf-8");
}

type TestServer = {
	port: number;
	stop(force?: boolean): Promise<void>;
};

async function startServer(
	fetch: (request: Request) => Response,
): Promise<TestServer | undefined> {
	let lastError: unknown;
	for (let attempt = 0; attempt < 20; attempt++) {
		const port = 32_000 + Math.floor(Math.random() * 20_000);
		const server = createServer(async (request, response) => {
			const result = await fetch(
				new Request(`http://127.0.0.1:${port}${request.url ?? "/"}`),
			);
			response.writeHead(result.status, Object.fromEntries(result.headers));
			response.end(await result.text());
		});
		const error = await listen(server, port);
		if (!error) {
			return {
				port,
				stop: () => new Promise((resolve) => server.close(() => resolve())),
			};
		}
		lastError = error;
		if (!isAddressInUse(error)) return undefined;
	}
	throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function listen(server: ReturnType<typeof createServer>, port: number) {
	return new Promise<unknown>((resolve) => {
		server.once("error", resolve);
		try {
			server.listen(port, "127.0.0.1", () => resolve(undefined));
		} catch (error) {
			resolve(error);
		}
	});
}

function isAddressInUse(error: unknown): boolean {
	return (
		(error !== null &&
			typeof error === "object" &&
			"code" in error &&
			error.code === "EADDRINUSE") ||
		/port .+ in use|EADDRINUSE/i.test(String(error))
	);
}

function page(title: string, body: string): string {
	return `<!doctype html>
<html>
	<head>
		<title>${title}</title>
		<meta name="description" content="${fixtureText}">
	</head>
	<body>
		<main>
			<h1>${title}</h1>
			${body}
		</main>
	</body>
</html>`;
}

function text(body: string, contentType: string, status = 200): Response {
	return new Response(body, {
		status,
		headers: { "content-type": contentType },
	});
}

function trimSlash(pathname: string): string {
	return pathname !== "/" ? pathname.replace(/\/+$/, "") : pathname;
}

async function listFiles(dir: string, base = dir): Promise<string[]> {
	const out: string[] = [];
	for (const entry of await readdir(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) out.push(...(await listFiles(path, base)));
		else out.push(relative(base, path));
	}
	return out.sort();
}

function cleanEnv(): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value !== undefined) env[key] = value;
	}
	return env;
}

function assert(
	condition: unknown,
	message = "assertion failed",
): asserts condition {
	if (!condition) throw new Error(message);
}
