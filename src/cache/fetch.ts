import type { ConditionalRequest, Config, FetchResult } from "../core/types.ts";
import { validatePublicHttpUrl } from "../security/url.ts";
import {
	acquireCacheLock,
	cacheConditional,
	cachedFetchResult,
	cacheRequest,
	readCache,
	refreshCacheEntry,
	releaseCacheLock,
	writeCacheResult,
} from "./store.ts";

export type UncachedFetch = (
	url: string,
	config: Config,
	accept: string,
	conditional?: ConditionalRequest,
) => Promise<FetchResult>;

export async function fetchWithCache(
	url: string,
	config: Config,
	accept: string,
	conditional: ConditionalRequest | undefined,
	uncached: UncachedFetch,
): Promise<FetchResult> {
	if (conditional || validatePublicHttpUrl(url)) {
		const result = await uncached(url, config, accept, conditional);
		if (
			!conditional ||
			!result.ok ||
			isNotModifiedResult(result) ||
			validatePublicHttpUrl(url)
		) {
			return result;
		}
		await writeThroughCache(url, config, accept, result);
		return result;
	}
	const started = performance.now();
	const request = cacheRequest(url, config, accept);
	const first = await readCache(config, request);
	if (first.state === "fresh") {
		return cachedFetchResult(
			url,
			first.entry,
			first.body,
			performance.now() - started,
		);
	}
	if (first.state === "disabled") return uncached(url, config, accept);

	const lock = await acquireCacheLock(config, first.key);
	if (!lock) {
		const afterWait = await readCache(config, request);
		if (afterWait.state === "fresh") {
			return cachedFetchResult(
				url,
				afterWait.entry,
				afterWait.body,
				performance.now() - started,
			);
		}
		return uncached(url, config, accept);
	}
	try {
		const latest = await readCache(config, request, { count: false });
		if (latest.state === "fresh") {
			return cachedFetchResult(
				url,
				latest.entry,
				latest.body,
				performance.now() - started,
			);
		}
		const stale =
			latest.state === "stale"
				? latest
				: first.state === "stale"
					? first
					: undefined;
		const result = await uncached(
			url,
			config,
			accept,
			stale ? cacheConditional(stale.entry) : undefined,
		);
		if (isNotModifiedResult(result) && stale) {
			const entry = await refreshCacheEntry(
				config,
				first.key,
				stale.entry,
				result,
			);
			return cachedFetchResult(
				url,
				entry,
				stale.body,
				performance.now() - started,
			);
		}
		await writeCacheResult(config, first.key, request, result);
		return result;
	} finally {
		await releaseCacheLock(lock);
	}
}

async function writeThroughCache(
	url: string,
	config: Config,
	accept: string,
	result: FetchResult,
) {
	const request = cacheRequest(url, config, accept);
	const key = (await readCache(config, request, { count: false })).key;
	const lock = await acquireCacheLock(config, key);
	if (!lock) return;
	try {
		await writeCacheResult(config, key, request, result);
	} finally {
		await releaseCacheLock(lock);
	}
}

function isNotModifiedResult(
	result: FetchResult,
): result is FetchResult & { ok: true; notModified: true } {
	return result.ok && "notModified" in result && result.notModified === true;
}
