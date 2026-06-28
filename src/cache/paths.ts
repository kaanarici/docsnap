import { resolve } from "node:path";
import { assertInsideRoot } from "../core/fs-safety.ts";

type CachePathContext = { dir: string | null };

const cacheHexPattern = /^[0-9a-f]{64}$/;

export function isCacheHex(value: unknown): value is string {
	return typeof value === "string" && cacheHexPattern.test(value);
}

export function entryKeyFromFileName(name: string): string | undefined {
	if (!name.endsWith(".json")) return undefined;
	const key = name.slice(0, -5);
	return isCacheHex(key) ? key : undefined;
}

export function entryPath(context: CachePathContext, key: string): string {
	if (!isCacheHex(key)) throw new Error("invalid cache entry key");
	return pathFor(context, "entries", `${key}.json`);
}

export function blobPath(context: CachePathContext, hash: string): string {
	if (!isCacheHex(hash)) throw new Error("invalid cache blob hash");
	return pathFor(context, "blobs", "sha256", hash);
}

export function lockPath(context: CachePathContext, key: string): string {
	if (!isCacheHex(key)) throw new Error("invalid cache lock key");
	return pathFor(context, "locks", `${key}.lock`);
}

export function pathFor(context: CachePathContext, ...parts: string[]): string {
	if (!context.dir) throw new Error("cache disabled");
	return assertInsideCache(context.dir, resolve(context.dir, ...parts));
}

function assertInsideCache(root: string, target: string): string {
	return assertInsideRoot(root, target, `cache path escapes root: ${target}`);
}
