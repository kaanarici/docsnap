import { expect, test } from "bun:test";
import { parseArgs } from "../src/cli/args.ts";
import { snapshotStats } from "../src/core/snapshot.ts";
import { buildSummary } from "../src/report/summary.ts";
import { commitRun, tempDir, testConfig, testPage } from "./fixtures.ts";

const entry = new URL("../src/entry.ts", import.meta.url).pathname;

async function runCli(args: string[], env = process.env) {
	const child = Bun.spawn([process.execPath, entry, ...args], {
		env,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [exitCode, stdout, stderr] = await Promise.all([
		child.exited,
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
	]);
	return { exitCode, stdout, stderr };
}

test("keeps tokens after -- as literal fetch question text", () => {
	const parsed = parseArgs([
		"fetch",
		"https://docs.example.com/guide",
		"--",
		"--site",
		"literal question",
	]);
	expect(parsed).toMatchObject({
		kind: "fetch",
		fetch: { question: "--site literal question" },
	});
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
	expect(result.data.commands).toHaveLength(6);
	expect(result.data.commands.slice(0, 3)).toMatchObject([
		{ name: "capture", effects: "idempotent" },
		{ name: "map", effects: "read_only" },
		{ name: "fetch", effects: "idempotent" },
	]);
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

test("quiet capture still returns one structured result", async () => {
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
	try {
		const { exitCode, stdout, stderr } = await runCli(
			[origin, "--page", "--dry-run", "--quiet"],
			{ ...process.env, DOCSNAP_ALLOW_TEST_HOST: origin },
		);
		expect(exitCode).toBe(0);
		expect(JSON.parse(stdout)).toMatchObject({
			ok: true,
			message: "Dry run found 1 page. No files were written.",
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

test("explicit reuse keeps a usable corpus with quality warnings", async () => {
	const outputDir = await tempDir("fetch-reuse");
	const page = { ...testPage(), qualityReasons: ["thin content"] };
	const config = testConfig(outputDir);
	const summary = buildSummary(
		[page],
		[page],
		config,
		snapshotStats([{ path: page.outputPath, body: page.rendered }]),
	);
	await commitRun([page], [page], summary, config);

	const { exitCode, stdout, stderr } = await runCli([
		"fetch",
		config.seedUrl,
		"documentation",
		"--out",
		outputDir,
		"--freshness",
		"reuse",
		"--quiet",
	]);
	const result = JSON.parse(stdout);
	expect(exitCode).toBe(0);
	expect(stderr).toBe("");
	expect(result).toMatchObject({
		ok: true,
		data: {
			action: "reused",
			counts: { written: 1, lowQuality: 1 },
		},
		warnings: ["1 page is low quality."],
	});
});
