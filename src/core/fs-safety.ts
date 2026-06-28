import { realpathSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import {
	basename,
	dirname,
	isAbsolute,
	join,
	parse,
	relative,
	resolve,
} from "node:path";

// Top-level directories under $HOME that hold user data, not docsnap artifacts.
// A cache or output root may not BE the filesystem root, $HOME, or one of these.
const protectedHomeDirs = new Set([
	"Applications",
	"Desktop",
	"Documents",
	"Downloads",
	"Library",
	"Movies",
	"Music",
	"Pictures",
	"Public",
]);

export function isInsideOrSame(parent: string, child: string): boolean {
	const path = relative(parent, child);
	return path === "" || (!path.startsWith("..") && !parse(path).root);
}

function isInsideRoot(root: string, target: string): boolean {
	return isInsideOrSame(resolve(root), resolve(target));
}

export function assertInsideRoot(
	root: string,
	target: string,
	message: string,
): string {
	const next = resolve(target);
	if (!isInsideRoot(root, next)) throw new Error(message);
	return next;
}

function isSafeRelativePath(path: string): boolean {
	return (
		path.trim() !== "" &&
		!isAbsolute(path) &&
		!isWindowsAbsolute(path) &&
		!path.split(/[\\/]+/).includes("..")
	);
}

export function resolveSafeRelativePath(
	root: string,
	path: string,
): string | undefined {
	if (!isSafeRelativePath(path)) return undefined;
	const base = resolve(root);
	const target = resolve(base, path);
	return isInsideOrSame(base, target) ? target : undefined;
}

export async function realPathIsInside(
	root: string,
	target: string,
): Promise<boolean> {
	let current = resolve(target);
	for (;;) {
		try {
			return isInsideOrSame(root, await realpath(current));
		} catch (error) {
			if (!(error instanceof Error) || !("code" in error)) throw error;
			if (error.code !== "ENOENT") throw error;
			const next = dirname(current);
			if (next === current) return false;
			current = next;
		}
	}
}

export async function assertRealPathInside(
	root: string,
	target: string,
	message: string,
): Promise<void> {
	if (!(await realPathIsInside(root, target))) throw new Error(message);
}

export function isWindowsAbsolute(path: string): boolean {
	return /^[a-zA-Z]:[\\/]/.test(path) || path.startsWith("\\\\");
}

// Reject roots that are the filesystem root, $HOME, or a protected $HOME child.
// Checks the resolved path AND its realpath so a symlink cannot disguise an
// unsafe destination as a benign-looking root.
export function assertSafeRoot(dir: string, message: string): void {
	const resolved = resolve(dir);
	if (isUnsafeRoot(resolved) || isUnsafeRoot(realRoot(resolved))) {
		throw new Error(message);
	}
}

function isUnsafeRoot(dir: string): boolean {
	const root = parse(dir).root;
	const home = resolve(homedir());
	const isProtectedHomeDir =
		dirname(dir) === home && protectedHomeDirs.has(basename(dir));
	return dir === root || dir === home || isTempRoot(dir) || isProtectedHomeDir;
}

function isTempRoot(dir: string): boolean {
	return [
		resolve(tmpdir()),
		realRoot(resolve(tmpdir())),
		resolve("/tmp"),
		realRoot(resolve("/tmp")),
		resolve("/private/tmp"),
	].includes(dir);
}

// Resolve symlinks on the existing portion of the path while preserving the
// not-yet-created tail (the cache/output dir is often created after validation),
// so a fresh path like ~/proj/out stays itself instead of collapsing onto its
// nearest existing ancestor ($HOME) and being wrongly rejected.
function realRoot(dir: string): string {
	const tail: string[] = [];
	let current = dir;
	for (;;) {
		try {
			const real = realpathSync.native(current);
			return tail.length ? join(real, ...tail) : real;
		} catch (error) {
			if (!(error instanceof Error) || !("code" in error)) throw error;
			if (error.code !== "ENOENT") throw error;
			const next = dirname(current);
			if (next === current) return join(current, ...tail);
			tail.unshift(basename(current));
			current = next;
		}
	}
}
