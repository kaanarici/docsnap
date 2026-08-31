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

// The bin is a sh/JS polyglot. Shebang execution (bun or npm installs on
// POSIX) execs Bun in place, so signals reach the CLI directly and Node is
// never required. Windows shims and direct \`node docsnap.cjs\` runs take the
// JS path, which re-runs through Bun or fails with a structured error.
const bunRequired = JSON.stringify({
	ok: false,
	message: "DocSnap requires the Bun runtime, and bun was not found on PATH.",
	next: "Install Bun from https://bun.sh, then rerun this command.",
	data: null,
	error: { code: "BUN_REQUIRED", retryable: false },
	warnings: [],
});
const launcher = `#!/bin/sh
// 2>/dev/null; if command -v bun >/dev/null 2>&1; then exec bun "$0" "$@"; fi; echo '${bunRequired}' >&2; exit 1
"use strict";
const { join } = require("node:path");
const entry = join(__dirname, "entry.ts");
if (typeof Bun !== "undefined") {
	import(entry);
} else {
	const { spawn } = require("node:child_process");
	const child = spawn("bun", [entry, ...process.argv.slice(2)], {
		stdio: "inherit",
	});
	child.on("error", (error) => {
		if (error.code !== "ENOENT") throw error;
		console.error(${JSON.stringify(bunRequired)});
		process.exit(1);
	});
	for (const signal of ["SIGINT", "SIGTERM"]) {
		process.on(signal, () => child.kill(signal));
	}
	child.on("close", (code, signal) => {
		process.exit(signal === "SIGINT" ? 130 : signal ? 143 : (code ?? 1));
	});
}
`;
await Bun.write(join(outdir, "docsnap.cjs"), launcher);
await chmod(join(outdir, "docsnap.cjs"), 0o755);
