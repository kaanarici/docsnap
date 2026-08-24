import { releaseDirLock } from "../core/dir-lock.ts";
import type {
	ConditionalRequest,
	FetchResult,
	PipelineConfig,
} from "../core/types.ts";
import { validatePublicHttpUrl } from "../security/url.ts";
import { isNotModifiedResult } from "./policy.ts";
import type { CacheLookup, CacheRequest } from "./store.ts";
import {
	acquireCacheWriteLock,
	cacheConditional,
	cachedFetchResult,
	cacheRequest,
	readCache,
	refreshCacheEntry,
	writeCacheResult,
} from "./store.ts";

type UrlGate = (url: string) => boolean | Promise<boolean>;

export type UncachedFetch = (
	url: string,
	config: PipelineConfig,
	accept: string,
	conditional?: ConditionalRequest,
	allowUrl?: UrlGate,
) => Promise<FetchResult>;

const inFlight = new WeakMap<
	PipelineConfig,
	Map<string, Promise<FetchResult>>
>();

export async function fetchWithCache(
	url: string,
	config: PipelineConfig,
	accept: string,
	conditional: ConditionalRequest | undefined,
	uncached: UncachedFetch,
	allowUrl?: UrlGate,
): Promise<FetchResult> {
	const unsafe = validatePublicHttpUrl(url);
	if (conditional || unsafe) {
		const result = await uncached(url, config, accept, conditional, allowUrl);
		if (!conditional || !result.ok || isNotModifiedResult(result) || unsafe) {
			return result;
		}
		await writeThroughCache(url, config, accept, result);
		return result;
	}
	const started = performance.now();
	const request = cacheRequest(url, config, accept);
	const first = await readCache(config, request);
	if (first.state === "fresh") {
		const hit = await freshHit(url, first, started, allowUrl);
		if (hit) return hit;
	}
	if (first.state === "disabled")
		return uncached(url, config, accept, undefined, allowUrl);

	return singleFlight(config, first.key, () =>
		fillCold(url, config, accept, request, first, uncached, allowUrl),
	);
}

function singleFlight(
	config: PipelineConfig,
	key: string,
	run: () => Promise<FetchResult>,
): Promise<FetchResult> {
	let pending = inFlight.get(config);
	if (!pending) {
		pending = new Map();
		inFlight.set(config, pending);
	}
	const existing = pending.get(key);
	if (existing) return existing;
	const promise = run().finally(() => pending.delete(key));
	pending.set(key, promise);
	return promise;
}

async function fillCold(
	url: string,
	config: PipelineConfig,
	accept: string,
	request: CacheRequest,
	first: CacheLookup,
	uncached: UncachedFetch,
	allowUrl: UrlGate | undefined,
): Promise<FetchResult> {
	const started = performance.now();
	const lock = await acquireCacheWriteLock(config, request);
	if (!lock) {
		const afterWait = await readCache(config, request);
		if (afterWait.state === "fresh") {
			const hit = await freshHit(url, afterWait, started, allowUrl);
			if (hit) return hit;
		}
		return uncached(url, config, accept, undefined, allowUrl);
	}
	try {
		const latest = await readCache(config, request, { count: false });
		if (latest.state === "fresh") {
			const hit = await freshHit(url, latest, started, allowUrl);
			if (hit) return hit;
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
			allowUrl,
		);
		if (isNotModifiedResult(result) && stale) {
			const entry = await refreshCacheEntry(config, lock, stale.entry, result);
			return cachedFetchResult(
				entry,
				stale.body,
				performance.now() - started,
				url,
			);
		}
		await writeCacheResult(config, lock, result);
		return result;
	} finally {
		await releaseDirLock(lock);
	}
}

async function freshHit(
	url: string,
	lookup: Extract<CacheLookup, { body: string }>,
	started: number,
	allowUrl: UrlGate | undefined,
): Promise<FetchResult | undefined> {
	const result = cachedFetchResult(
		lookup.entry,
		lookup.body,
		performance.now() - started,
		url,
	);
	if (!allowUrl) return result;
	if (result.url === result.finalUrl && (result.redirects?.length ?? 0) === 0)
		return result;
	try {
		return (await allowUrl(result.finalUrl)) ? result : undefined;
	} catch {
		return undefined;
	}
}

async function writeThroughCache(
	url: string,
	config: PipelineConfig,
	accept: string,
	result: FetchResult,
) {
	const request = cacheRequest(url, config, accept);
	const lock = await acquireCacheWriteLock(config, request);
	if (!lock) return;
	try {
		await writeCacheResult(config, lock, result);
	} finally {
		await releaseDirLock(lock);
	}
}
