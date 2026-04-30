import { readdir } from "node:fs/promises";
import { join } from "node:path";

const roots = ["src", "scripts", "test"];
const limit = 500;
const offenders: string[] = [];

type DirectoryEntry = {
	name: string;
	isDirectory: () => boolean;
};

async function walk(dir: string) {
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
			await walk(path);
			continue;
		}
		if (!/\.(ts|tsx|js|jsx)$/.test(entry.name)) continue;
		const lines = (await Bun.file(path).text()).split("\n").length;
		if (lines > limit) offenders.push(`${path}: ${lines} lines`);
	}
}

for (const root of roots) await walk(root);

if (offenders.length) {
	console.error(`Files over ${limit} lines:\n${offenders.join("\n")}`);
	process.exit(1);
}
