import { expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { parseArgs } from "../src/cli/args.ts";
import { tempDir } from "./fixtures.ts";

const entry = new URL("../src/entry.ts", import.meta.url).pathname;

async function runCli(args: string[], env = process.env, stdin?: string) {
	const child = Bun.spawn([process.execPath, entry, ...args], {
		env,
		stdin: stdin === undefined ? "ignore" : "pipe",
		stdout: "pipe",
		stderr: "pipe",
	});
	if (stdin !== undefined && typeof child.stdin !== "number" && child.stdin) {
		child.stdin.write(stdin);
		child.stdin.end();
	}
	const [exitCode, stdout, stderr] = await Promise.all([
		child.exited,
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
	]);
	return { exitCode, stdout, stderr };
}

test("parses repeatable path filters for capture and map", () => {
	expect(
		parseArgs([
			"https://docs.example.com",
			"--include",
			"/docs/**",
			"--exclude",
			"/docs/internal/**",
		]),
	).toMatchObject({
		kind: "run",
		run: {
			include: ["/docs/**"],
			exclude: ["/docs/internal/**"],
		},
	});
	expect(
		parseArgs(["map", "https://docs.example.com", "--include", "/api/**"]),
	).toMatchObject({ kind: "map", map: { include: ["/api/**"] } });
});

test("describes every command in one JSON help response", async () => {
	const { exitCode, stdout, stderr } = await runCli(["--help"]);
	const result = JSON.parse(stdout);
	expect(exitCode).toBe(0);
	expect(stderr).toBe("");
	expect(result).toMatchObject({
		ok: true,
		error: null,
		data: {
			tool: "docsnap",
		},
	});
	expect(result.data.commands).toMatchObject([
		{ name: "capture" },
		{ name: "map", writes: ["shared HTTP cache"] },
		{ name: "refresh" },
	]);
	expect(result.data.details).toContain("--include");
});

test("returns version as one JSON result", async () => {
	const { exitCode, stdout, stderr } = await runCli(["--version"]);
	expect(exitCode).toBe(0);
	expect(stderr).toBe("");
	expect(JSON.parse(stdout)).toMatchObject({
		ok: true,
		message: "DocSnap 2.0.0.",
		data: { version: "2.0.0" },
		error: null,
		warnings: [],
	});
});

test("returns a structured usage error on stderr for an unsafe URL", async () => {
	const { exitCode, stdout, stderr } = await runCli(["http://127.0.0.1"]);
	expect(exitCode).toBe(2);
	expect(stdout).toBe("");
	expect(JSON.parse(stderr)).toMatchObject({
		ok: false,
		message: "Unsafe URL: private or internal IP addresses are not allowed",
		error: { code: "INVALID_ARGUMENT", retryable: false },
		warnings: [],
	});
});

test("explains when --out names a file", async () => {
	const outputPath = join(await tempDir("output-file"), "corpus");
	await writeFile(outputPath, "not a directory");
	const { exitCode, stdout, stderr } = await runCli([
		"https://docs.example.com",
		"--out",
		outputPath,
	]);
	expect(exitCode).toBe(2);
	expect(stdout).toBe("");
	expect(JSON.parse(stderr)).toMatchObject({
		ok: false,
		message: `Output path is not a directory: ${outputPath}`,
		next: "Choose a directory path with --out.",
		error: { code: "INVALID_ARGUMENT", retryable: false },
	});
});

test("capture returns one structured result", async () => {
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: () =>
			new Response(
				`<main><h1>Docs</h1><p>${"Useful documentation content for a coding agent. ".repeat(20)}</p></main>`,
				{ headers: { "content-type": "text/html" } },
			),
	});
	const origin = new URL(server.url).origin;
	const outputDir = await tempDir("cli-result");
	try {
		const { exitCode, stdout, stderr } = await runCli(
			["capture", origin, "--page", "--out", outputDir],
			{ ...process.env, DOCSNAP_ALLOW_TEST_HOST: origin },
		);
		expect(exitCode).toBe(0);
		expect(JSON.parse(stdout)).toMatchObject({
			ok: true,
			message: "Captured 1 page.",
			data: { written: 1 },
			error: null,
			warnings: [],
		});
		expect(Object.keys(JSON.parse(stdout))).toEqual([
			"ok",
			"message",
			"next",
			"data",
			"error",
			"warnings",
		]);
		expect(stderr).toBe("");
	} finally {
		server.stop(true);
	}
});

test("captures newline-delimited stdin URLs into separate corpora", async () => {
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(request) {
			const path = new URL(request.url).pathname;
			return new Response(
				`<main><h1>${path}</h1><p>${`Documentation for ${path}. `.repeat(20)}</p></main>`,
				{ headers: { "content-type": "text/html" } },
			);
		},
	});
	const origin = new URL(server.url).origin;
	const outputRoot = await tempDir("cli-batch");
	try {
		const result = await runCli(
			["--stdin", "--page", "--out", outputRoot, "--no-cache"],
			{ ...process.env, DOCSNAP_ALLOW_TEST_HOST: origin },
			`${origin}/one\n${origin}/two\n`,
		);
		expect(result.exitCode).toBe(0);
		expect(result.stderr).toBe("");
		const response = JSON.parse(result.stdout);
		expect(response).toMatchObject({
			ok: true,
			message: "Captured 2 corpora.",
			data: { total: 2, succeeded: 2, failed: 0 },
		});
		const outputDirs = response.data.results.map(
			(item: { data: { outputDir: string } }) => item.data.outputDir,
		);
		expect(new Set(outputDirs).size).toBe(2);
		for (const outputDir of outputDirs) {
			expect(
				await Bun.file(join(outputDir, "summary.json")).exists(),
			).toBeTrue();
			expect(await Bun.file(join(outputDir, "index.md")).text()).toContain(
				"Documentation for",
			);
		}
	} finally {
		server.stop(true);
	}
});

test("rejects oversized stdin lines before capture", async () => {
	const result = await runCli(
		["--stdin", "--page"],
		process.env,
		`${"https://docs.example.com/"}${"x".repeat(16_384)}\n`,
	);
	expect(result.exitCode).toBe(2);
	expect(result.stdout).toBe("");
	expect(JSON.parse(result.stderr)).toMatchObject({
		ok: false,
		error: { code: "INVALID_ARGUMENT", retryable: false },
	});
});

test("rejects more than 32 stdin URLs incrementally", async () => {
	const urls = Array.from(
		{ length: 33 },
		(_, index) => `https://docs.example.com/${index}`,
	).join("\n");
	const result = await runCli(["--stdin", "--page"], process.env, urls);
	expect(result.exitCode).toBe(2);
	expect(result.stdout).toBe("");
	expect(JSON.parse(result.stderr)).toMatchObject({
		ok: false,
		message: "--stdin accepts 32 URLs or fewer",
		error: { code: "INVALID_ARGUMENT", retryable: false },
	});
});

test("cancels a capture with one structured failure and releases its lock", async () => {
	let requestSeen = false;
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: async () => {
			requestSeen = true;
			await Bun.sleep(250);
			return new Response(
				`<main><h1>Slow</h1><p>${"Documentation content. ".repeat(20)}</p></main>`,
				{ headers: { "content-type": "text/html" } },
			);
		},
	});
	const origin = new URL(server.url).origin;
	const outputDir = await tempDir("cli-cancel");
	const child = Bun.spawn(
		[process.execPath, entry, origin, "--page", "--out", outputDir],
		{
			env: { ...process.env, DOCSNAP_ALLOW_TEST_HOST: origin },
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	try {
		while (!requestSeen) await Bun.sleep(1);
		child.kill("SIGTERM");
		const [exitCode, stdout, stderr] = await Promise.all([
			child.exited,
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
		]);
		expect(exitCode).toBe(143);
		expect(stdout).toBe("");
		expect(JSON.parse(stderr)).toMatchObject({
			ok: false,
			message: "Capture cancelled by SIGTERM.",
			error: { code: "CANCELLED", retryable: true },
		});
		expect(
			await Bun.file(join(outputDir, "summary.json")).exists(),
		).toBeFalse();
		expect(
			await Bun.file(
				join(dirname(outputDir), `.${basename(outputDir)}.docsnap-lock`),
			).exists(),
		).toBeFalse();
	} finally {
		server.stop(true);
	}
});

test("reports an all-429 page capture as retryable rate limited", async () => {
	let rateLimitedRequests = 0;
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: (request) => {
			if (new URL(request.url).searchParams.has("view")) {
				rateLimitedRequests++;
			}
			return rateLimitedRequests === 1
				? new Response("slow down", {
						status: 429,
						headers: { "retry-after": "Wed, 21 Oct 2015 07:28:00 GMT" },
					})
				: new Response("slow down", { status: 429 });
		},
	});
	const origin = new URL(server.url).origin;
	const url = `${origin}/?view=rate-limit`;
	const outputDir = await tempDir("cli-rate-limit");
	try {
		const result = await runCli(
			[url, "--page", "--out", outputDir, "--no-cache"],
			{ ...process.env, DOCSNAP_ALLOW_TEST_HOST: origin },
		);
		expect(result.exitCode).toBe(1);
		expect(result.stdout).toBe("");
		expect(JSON.parse(result.stderr)).toMatchObject({
			ok: false,
			next: "Use the saved pages if incomplete coverage is enough. Otherwise retry at or after 2015-10-21T07:28:00.000Z.",
			error: {
				code: "RATE_LIMITED",
				retryable: true,
				details: {
					stopReason: "rate_limited",
					retryAt: "2015-10-21T07:28:00.000Z",
					byFailureKind: { http: 1 },
				},
			},
		});
	} finally {
		server.stop(true);
	}
});

test("refresh updates a corpus using its stored URL", async () => {
	let version = "First";
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: () =>
			new Response(
				`<main><h1>${version}</h1><p>${`${version} documentation content. `.repeat(20)}</p></main>`,
				{ headers: { "content-type": "text/html" } },
			),
	});
	const origin = new URL(server.url).origin;
	const outputDir = await tempDir("cli-refresh");
	const env = { ...process.env, DOCSNAP_ALLOW_TEST_HOST: origin };
	try {
		expect(
			(await runCli([origin, "--page", "--out", outputDir, "--no-cache"], env))
				.exitCode,
		).toBe(0);
		version = "Second";
		const refreshed = await runCli(["refresh", outputDir, "--no-cache"], env);
		expect(refreshed.exitCode).toBe(0);
		expect(JSON.parse(refreshed.stdout)).toMatchObject({
			ok: true,
			message: "Refreshed 1 page. 1 changed.",
			data: {
				written: 1,
				changes: {
					new: 0,
					changed: 1,
					unchanged: 0,
					removed: 0,
					pages: [{ change: "changed", path: "index.md" }],
				},
			},
		});
		const manifest = JSON.parse(
			(await Bun.file(join(outputDir, "manifest.jsonl")).text()).trim(),
		);
		expect(
			await Bun.file(join(outputDir, manifest.outputPath)).text(),
		).toContain("Second documentation content.");
	} finally {
		server.stop(true);
	}
});

test("regenerates a generator-less corpus without changing its page path", async () => {
	let version = "First";
	let conditionalRequests = 0;
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: (request) => {
			if (request.headers.has("if-none-match")) {
				conditionalRequests++;
				return new Response(null, { status: 304, headers: { etag: '"v1"' } });
			}
			return new Response(
				`<main><h1>${version}</h1><p>${`${version} documentation content. `.repeat(20)}</p></main>`,
				{
					headers: { "content-type": "text/html", etag: '"v1"' },
				},
			);
		},
	});
	const url = `${new URL(server.url).origin}/?view=guide`;
	const outputDir = await tempDir("cli-generator-refresh");
	const env = {
		...process.env,
		DOCSNAP_ALLOW_TEST_HOST: new URL(server.url).origin,
	};
	try {
		expect(
			(await runCli([url, "--page", "--out", outputDir, "--no-cache"], env))
				.exitCode,
		).toBe(0);
		const summaryPath = join(outputDir, "summary.json");
		const firstSummary = JSON.parse(await Bun.file(summaryPath).text());
		expect(firstSummary.generator).toBe("docsnap@2.0.0");
		delete firstSummary.generator;
		await Bun.write(summaryPath, `${JSON.stringify(firstSummary, null, 2)}\n`);
		const firstManifest = JSON.parse(
			(await Bun.file(join(outputDir, "manifest.jsonl")).text()).trim(),
		);
		version = "Second";
		const refreshed = await runCli(["refresh", outputDir, "--no-cache"], env);
		expect(refreshed.exitCode).toBe(0);
		expect(conditionalRequests).toBe(0);
		const nextManifest = JSON.parse(
			(await Bun.file(join(outputDir, "manifest.jsonl")).text()).trim(),
		);
		expect(nextManifest.outputPath).toBe(firstManifest.outputPath);
		expect(
			await Bun.file(join(outputDir, nextManifest.outputPath)).text(),
		).toContain("Second documentation content.");
	} finally {
		server.stop(true);
	}
});

test("explains when refresh is not given a corpus", async () => {
	const outputDir = await tempDir("missing-refresh-corpus");
	const result = await runCli(["refresh", outputDir]);
	expect(result.exitCode).toBe(2);
	expect(result.stdout).toBe("");
	expect(JSON.parse(result.stderr)).toMatchObject({
		ok: false,
		message: "Corpus file not found: summary.json",
		next: "Pass a readable DocSnap corpus directory containing summary.json, or capture it first.",
		error: { code: "INVALID_ARGUMENT", retryable: false },
	});
});
