import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import {
	sandboxNetworkDisabled,
	startLoopbackServer,
	type TestServer,
} from "../scripts/local-fixture.ts";
import { parseArgs } from "../src/cli/args.ts";

type CliResult = Summary & {
	ok: boolean;
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
	byExtractor: { html?: number } & Record<string, number | undefined>;
	byInlineStateSource: Record<string, number | undefined>;
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

let origin = "";

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

describe.skipIf(sandboxNetworkDisabled())("CLI capture", () => {
	let outDir = "";
	let server: TestServer | undefined;
	let tmpRoot = "";

	beforeAll(async () => {
		tmpRoot = await mkdtemp(join(tmpdir(), "docsnap-cli-"));
		outDir = join(tmpRoot, "capture");
		server = await startLoopbackServer(fixtureResponse);
		origin = server.origin;
	});

	afterAll(async () => {
		await server?.stop();
		await rm(tmpRoot, { recursive: true, force: true });
	});

	test("captures local docs through the real binary", async () => {
		const help = parseArgs([]);
		expect("help" in help).toBe(true);

		const result = await runCli(origin, outDir);
		expect(result.ok).toBe(true);
		expect(result.written).toBeGreaterThan(0);
		expect(result.outDir).toBe(outDir);
		expect(Boolean(result.paths)).toBe(true);

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

		expect(summary.written).toBe(
			manifest.filter((record) => record.outputPath).length,
		);
		expect(summary.failed).toBe(manifest.filter((record) => !record.ok).length);
		expect(summary.written + summary.failed).toBe(manifest.length);
		expect(result.written).toBe(summary.written);
		expect(result.failed).toBe(summary.failed);
		expect(result.byExtractor.html).toBe(summary.byExtractor.html);
		expect(result).toHaveProperty("byInlineStateSource");
		expect(JSON.stringify(result.byInlineStateSource)).toBe(
			JSON.stringify(summary.byInlineStateSource),
		);

		const missing = manifest.find((record) => record.url.endsWith("/missing"));
		expect(missing?.ok).toBe(false);
		if (!missing || missing.ok) throw new Error("expected missing record");
		expect(missing.failureKind).toBe("not_found");
		expect(summary.byFailureKind.not_found).toBe(1);
		expect(summary.errors.some((error) => error.url.endsWith("/missing"))).toBe(
			true,
		);

		const files = await listFiles(outDir);
		for (const file of [
			"summary.json",
			"manifest.jsonl",
			"tree.txt",
			"AGENT_README.md",
		]) {
			expect(files).toContain(file);
		}
		const pageFiles = files.filter(
			(file) => file.endsWith(".md") && file !== "AGENT_README.md",
		);
		expect(pageFiles.length).toBeGreaterThan(0);
		const capturedPage = await readFile(join(outDir, pageFiles[0]!), "utf8");
		expect(capturedPage).toContain(fixtureText);
	});
});

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
	expect(exitCode, stderr || stdout).toBe(0);
	expect(stderr.trim(), stderr).toBe("");
	const trimmed = stdout.trim();
	expect(trimmed.split(/\r?\n/)).toHaveLength(1);
	const parsed = JSON.parse(trimmed);
	expect(parsed && typeof parsed === "object" && !Array.isArray(parsed)).toBe(
		true,
	);
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error("assertion failed");
	}
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
