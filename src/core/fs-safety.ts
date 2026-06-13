import { realpath } from "node:fs/promises";
import { dirname, isAbsolute, parse, relative, resolve } from "node:path";

export function isInsideOrSame(parent: string, child: string): boolean {
	const path = relative(parent, child);
	return path === "" || (!path.startsWith("..") && !parse(path).root);
}

export function isInsideRoot(root: string, target: string): boolean {
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

export function isSafeRelativePath(path: string): boolean {
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
