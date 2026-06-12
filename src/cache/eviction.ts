import { readdir, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import type { Config } from "../core/types.ts";
import {
	blobPath,
	type CacheContext,
	type CacheEntry,
	cacheContext,
	disableOnAccessError,
	isNotFound,
	parseEntry,
	pathFor,
} from "./store.ts";

const pruneTargetRatio = 0.8;

export async function pruneCache(config: Config): Promise<void> {
	const context = cacheContext(config);
	if (!context.enabled) return;
	try {
		const entries = await cacheEntries(context);
		const total = entries.reduce((sum, item) => sum + item.entry.bytes, 0);
		if (total <= context.maxBytes) return;
		const target = context.maxBytes * pruneTargetRatio;
		const victims = [...entries].sort((a, b) => a.mtimeMs - b.mtimeMs);
		let remaining = total;
		const deletedHashes = new Set<string>();
		for (const victim of victims) {
			if (remaining <= target) break;
			await rm(victim.path, { force: true });
			remaining -= victim.entry.bytes;
			context.stats.evictedBytes += victim.entry.bytes;
			deletedHashes.add(victim.entry.bodyHash);
		}
		const keptHashes = new Set(
			(await cacheEntries(context)).map((item) => item.entry.bodyHash),
		);
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
		if (!name.endsWith(".json")) continue;
		const path = join(dir, name);
		const [text, info] = await Promise.all([
			readFile(path, "utf8"),
			stat(path),
		]);
		const entry = parseEntry(text, name.slice(0, -5));
		if (entry) out.push({ path, entry, mtimeMs: info.mtimeMs });
	}
	return out;
}
