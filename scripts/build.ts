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
