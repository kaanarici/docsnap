import { readdir } from "node:fs/promises";
import { join } from "node:path";

const roots = ["src", "scripts"];
const softLimit = 500;

type DirectoryEntry = {
	name: string;
	isDirectory: () => boolean;
};

type FileSize = { path: string; lines: number };

async function walk(dir: string, out: FileSize[]) {
	let entries: DirectoryEntry[];
	try {
		entries = await readdir(dir, { withFileTypes: true });
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT")
			return;
		throw error;
	}
	for (const entry of entries) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) {
			await walk(path, out);
			continue;
		}
		if (!/\.(ts|tsx|js|jsx)$/.test(entry.name)) continue;
		const lines = (await Bun.file(path).text()).split("\n").length;
		out.push({ path, lines });
	}
}

const sizes: FileSize[] = [];
for (const root of roots) await walk(root, sizes);

const byRoot = new Map<string, { files: number; lines: number }>();
for (const { path, lines } of sizes) {
	const root = path.split("/")[0] ?? path;
	const acc = byRoot.get(root) ?? { files: 0, lines: 0 };
	acc.files++;
	acc.lines += lines;
	byRoot.set(root, acc);
}

const totalLines = sizes.reduce((sum, file) => sum + file.lines, 0);
const largest = [...sizes].sort((a, b) => b.lines - a.lines).slice(0, 10);

console.log(`size: ${sizes.length} files, ${totalLines} lines`);
for (const [root, acc] of byRoot)
	console.log(`  ${root}: ${acc.files} files, ${acc.lines} lines`);
console.log("largest:");
for (const file of largest) console.log(`  ${file.path}: ${file.lines}`);

const oversized = sizes.filter((file) => file.lines > softLimit);
if (oversized.length) {
	console.log(
		`\nover ${softLimit} lines (soft limit, not a failing check):\n${oversized
			.map((file) => `  ${file.path}: ${file.lines}`)
			.join("\n")}`,
	);
}
