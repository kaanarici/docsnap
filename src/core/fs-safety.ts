import { realpathSync } from "node:fs";
import { lstat, realpath, stat } from "node:fs/promises";
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

export function assertInsideRoot(
	root: string,
	target: string,
	message: string,
): string {
	const next = resolve(target);
	if (!isInsideOrSame(resolve(root), next)) throw new Error(message);
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

export async function assertTrustedMutationPath(
	dir: string,
	message: string,
): Promise<void> {
	const uid = process.getuid?.();
	if (uid === undefined) return;
	const resolved = resolve(dir);
	const existing = await nearestExistingPath(resolved);
	const real = await realpath(existing);
	const ownsRoot = existing === resolved;
	await assertTrustedAncestors(existing, uid, message, ownsRoot);
	if (real !== existing)
		await assertTrustedAncestors(real, uid, message, ownsRoot);
}

async function assertTrustedAncestors(
	path: string,
	uid: number,
	message: string,
	ownsRoot: boolean,
) {
	const root = await stat(path);
	if (
		!root.isDirectory() ||
		(root.uid !== uid && root.uid !== 0) ||
		(ownsRoot && (root.uid !== uid || (root.mode & 0o022) !== 0)) ||
		(!ownsRoot && (root.mode & 0o022) !== 0 && (root.mode & 0o1000) === 0)
	) {
		throw new Error(message);
	}
	let child = resolve(path);
	for (
		let parent = dirname(child);
		;
		child = parent, parent = dirname(parent)
	) {
		const info = await stat(parent);
		if (!info.isDirectory() || (info.uid !== uid && info.uid !== 0)) {
			throw new Error(message);
		}
		if ((info.mode & 0o022) !== 0) {
			const entry = await lstat(child);
			if ((info.mode & 0o1000) === 0 || entry.uid !== uid) {
				throw new Error(message);
			}
		}
		if (parent === dirname(parent)) return;
	}
}

async function nearestExistingPath(path: string): Promise<string> {
	for (let current = path; ; current = dirname(current)) {
		try {
			await lstat(current);
			return current;
		} catch (error) {
			if (!(error instanceof Error) || !("code" in error)) throw error;
			if (error.code !== "ENOENT" || current === dirname(current)) throw error;
		}
	}
}

export function isWindowsAbsolute(path: string): boolean {
	return /^[a-zA-Z]:[\\/]/.test(path) || path.startsWith("\\\\");
}

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
