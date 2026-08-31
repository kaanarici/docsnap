import { readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import type { PipelineConfig } from "../core/types.ts";
import { blobPath, entryKeyFromFileName, pathFor } from "./paths.ts";
import {
	type CacheContext,
	type CacheEntry,
	cacheContext,
	cacheReady,
	disableOnAccessError,
	isNotFound,
	readCacheEntry,
} from "./store.ts";

const pruneTargetRatio = 0.8;

export async function pruneCache(config: PipelineConfig): Promise<void> {
	const context = cacheContext(config);
	if (!(await cacheReady(context)) || !context.used) return;
	try {
		const entries = await cacheEntries(context);
		const total = entries.reduce((sum, item) => sum + item.entry.bytes, 0);
		if (total <= context.maxBytes) return;
		const target = context.maxBytes * pruneTargetRatio;
		const victims = [...entries].sort((a, b) => a.mtimeMs - b.mtimeMs);
		const kept = new Set(entries);
		let remaining = total;
		const deletedHashes = new Set<string>();
		for (const victim of victims) {
			if (remaining <= target) break;
			await rm(victim.path, { force: true });
			kept.delete(victim);
			remaining -= victim.entry.bytes;
			deletedHashes.add(victim.entry.bodyHash);
		}
		const keptHashes = new Set([...kept].map((item) => item.entry.bodyHash));
		await Promise.all(
			[...deletedHashes]
				.filter((hash) => !keptHashes.has(hash))
				.map((hash) => rm(blobPath(context, hash), { force: true })),
		);
	} catch (error) {
		if (!isNotFound(error)) disableOnAccessError(context, error);
	}
}

async function cacheEntries(context: CacheContext) {
	const dir = pathFor(context, "entries");
	const names = await readdir(dir);
	const out: Array<{ path: string; entry: CacheEntry; mtimeMs: number }> = [];
	for (const name of names) {
		const key = entryKeyFromFileName(name);
		if (!key) continue;
		const path = join(dir, name);
		const [entry, info] = await Promise.all([
			readCacheEntry(path, key),
			stat(path),
		]);
		if (entry) out.push({ path, entry, mtimeMs: info.mtimeMs });
	}
	return out;
}
