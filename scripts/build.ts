import { chmod, rm } from "node:fs/promises";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const outdir = join(root, "dist");

await rm(outdir, { force: true, recursive: true });
const result = await Bun.build({
	entrypoints: [
		join(root, "src/entry.ts"),
		join(root, "src/extract/worker.ts"),
	],
	minify: true,
	naming: { chunk: "chunk-[hash].js", entry: "[name].ts" },
	outdir,
	packages: "external",
	splitting: true,
	target: "bun",
});
if (!result.success)
	throw new Error(result.logs.map((message) => message.message).join("\n"));
await chmod(join(outdir, "entry.ts"), 0o755);

// The bin is a Node-compatible launcher: under Bun it imports the CLI
// directly; under Node it re-execs through Bun or fails with a JSON error.
const launcher = `#!/usr/bin/env node
"use strict";
const { join } = require("node:path");
const entry = join(__dirname, "entry.ts");
if (typeof Bun !== "undefined") {
	import(entry);
} else {
	const { spawnSync } = require("node:child_process");
	const run = spawnSync("bun", [entry, ...process.argv.slice(2)], {
		stdio: "inherit",
	});
	if (run.error && run.error.code === "ENOENT") {
		console.error(
			JSON.stringify({
				ok: false,
				message: "DocSnap requires the Bun runtime, and bun was not found on PATH.",
				next: "Install Bun from https://bun.sh, then rerun this command.",
				data: null,
				error: { code: "BUN_REQUIRED", retryable: false },
				warnings: [],
			}),
		);
		process.exit(1);
	}
	process.exit(run.status === null ? 1 : run.status);
}
`;
await Bun.write(join(outdir, "docsnap.cjs"), launcher);
await chmod(join(outdir, "docsnap.cjs"), 0o755);
