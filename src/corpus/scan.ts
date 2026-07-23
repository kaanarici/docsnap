import { readdir } from "node:fs/promises";
import { isAbsolute, join, parse, relative, resolve } from "node:path";
import {
	assertSafeRoot,
	isInsideOrSame,
	isWindowsAbsolute,
} from "../core/fs-safety.ts";
import { runFiles } from "../output/files.ts";

export const maxAllSearchScannedDirs = 5000;

const ignoredScanDirs = new Set([".git", "node_modules"]);
const skippedScanErrors = new Set(["EACCES", "EPERM", "ENOTDIR"]);

export type ScanOptions = {
	allowAbsoluteRoot?: boolean;
	preserveAbsolutePaths?: boolean;
};

export async function scanCorpora(
	rootDir: string,
	maxDirs = Number.POSITIVE_INFINITY,
	options: ScanOptions = {},
) {
	const root = scanRoot(rootDir, options);
	const found: string[] = [];
	let visited = 0;
	let truncated = false;
	let skipped = 0;
	async function walk(dir: string): Promise<void> {
		if (visited >= maxDirs) {
			truncated = true;
			return;
		}
		visited++;
		let entries: { name: string; isDirectory(): boolean }[];
		try {
			entries = await readdir(dir, { withFileTypes: true });
		} catch (error) {
			const code = errorCode(error);
			if (code === "ENOENT") return;
			if (skippedScanErrors.has(code)) {
				skipped++;
				return;
			}
			throw new Error("Unable to scan corpus directories under root_dir");
		}
		const names = new Set(entries.map((entry) => entry.name));
		if (names.has(runFiles.summary) && names.has(runFiles.manifest)) {
			found.push(options.preserveAbsolutePaths ? dir : displayPath(dir));
			return;
		}
		for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
			if (entry.isDirectory() && !ignoredScanDirs.has(entry.name))
				await walk(join(dir, entry.name));
		}
	}
	await walk(root);
	return { dirs: found, truncated, skipped };
}

export function assertSafeProjectRoot(rootDir: string): void {
	if (!rootDir || isAbsolute(rootDir) || isWindowsAbsolute(rootDir)) {
		throw new Error("root_dir must be a relative directory under cwd");
	}
	if (rootDir.split(/[\\/]+/).includes("..")) {
		throw new Error("root_dir must not contain '..'");
	}
	const cwd = resolve(process.cwd());
	const target = resolve(cwd, rootDir);
	if (!isInsideOrSame(cwd, target)) {
		throw new Error("root_dir must stay under cwd");
	}
}

function scanRoot(rootDir: string, options: ScanOptions): string {
	if (options.allowAbsoluteRoot && isAbsolute(rootDir)) {
		assertSafeRoot(
			rootDir,
			"root_dir must not be a filesystem root, home directory, or protected home directory",
		);
		return resolve(rootDir);
	}
	assertSafeProjectRoot(rootDir);
	return resolve(process.cwd(), rootDir);
}

function errorCode(error: unknown): string {
	return error instanceof Error && "code" in error ? String(error.code) : "";
}

function displayPath(path: string) {
	const rel = relative(process.cwd(), path);
	if (rel === "") return ".";
	return !rel.startsWith("..") && !parse(rel).root ? rel : path;
}
