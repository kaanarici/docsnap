import { expect, test } from "bun:test";
import { parseArgs } from "../src/cli/args.ts";

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

test("returns one JSON error and no stderr for an unsafe URL", async () => {
	const { exitCode, stdout, stderr } = await runCli([
		"http://127.0.0.1",
		"--json",
	]);
	expect(exitCode).toBe(1);
	expect(stderr).toBe("");
	expect(JSON.parse(stdout)).toEqual({
		ok: false,
		status: "error",
		error: "Unsafe URL: private or internal IP addresses are not allowed",
	});
});

test("quiet capture writes nothing", async () => {
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
		expect(stdout).toBe("");
		expect(stderr).toBe("");
	} finally {
		server.stop(true);
	}
});
