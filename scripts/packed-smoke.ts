import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const cli = Bun.argv[2];
if (!cli) throw new Error("packed CLI path is required");

const padding = "x".repeat(9 * 1024 * 1024);
const server = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	fetch() {
		return new Response(
			`<!doctype html><html><head><title>Packed smoke</title><style>${padding}</style></head><body><main><h1>Packed smoke</h1><p>The installed command can fetch, extract, and write a large HTML page through its packaged worker without relying on source files from the repository.</p></main></body></html>`,
			{ headers: { "content-type": "text/html; charset=utf-8" } },
		);
	},
});
const origin = new URL(server.url).origin;
const outputDir = await mkdtemp(join(tmpdir(), "docsnap-packed-smoke-"));

try {
	const child = Bun.spawn(
		[cli, origin, "--page", "--out", outputDir, "--clean", "--json"],
		{
			env: { ...process.env, DOCSNAP_ALLOW_TEST_HOST: origin },
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	const [exitCode, stdout, stderr] = await Promise.all([
		child.exited,
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
	]);
	if (exitCode !== 0) throw new Error(stderr || stdout || "packed CLI failed");
	const result = JSON.parse(stdout);
	if (!result.ok || result.status !== "ok" || result.written !== 1) {
		throw new Error(`unexpected packed CLI result: ${stdout}`);
	}
	const [summary, manifest, page] = await Promise.all([
		readFile(join(outputDir, "summary.json"), "utf8"),
		readFile(join(outputDir, "manifest.jsonl"), "utf8"),
		readFile(join(outputDir, "index.md"), "utf8"),
	]);
	if (!summary.includes('"status": "ok"')) throw new Error("invalid summary");
	if (!manifest.includes('"ok":true')) throw new Error("invalid manifest");
	if (!page.includes("installed command can fetch")) {
		throw new Error("captured page is missing expected content");
	}
} finally {
	server.stop(true);
	await rm(outputDir, { recursive: true, force: true });
}
