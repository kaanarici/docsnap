import { releaseDirLock } from "../core/dir-lock.ts";
import type { ConditionalRequest, Config, FetchResult } from "../core/types.ts";
import { validatePublicHttpUrl } from "../security/url.ts";
import { isNotModifiedResult } from "./policy.ts";
import type { CacheLookup, CacheRequest } from "./store.ts";
import {
	acquireCacheLock,
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
	config: Config,
	accept: string,
	conditional?: ConditionalRequest,
	allowUrl?: UrlGate,
) => Promise<FetchResult>;

// Process-local single-flight: concurrent same-key cold fetches share one
// network request and cache write instead of stampeding the origin. Scoped per
// Config (cache context) so unrelated runs never collide; cleared on settle.
const inFlight = new WeakMap<Config, Map<string, Promise<FetchResult>>>();

export async function fetchWithCache(
	url: string,
	config: Config,
	accept: string,
	conditional: ConditionalRequest | undefined,
	uncached: UncachedFetch,
	allowUrl?: UrlGate,
): Promise<FetchResult> {
	if (conditional || validatePublicHttpUrl(url)) {
		const result = await uncached(url, config, accept, conditional, allowUrl);
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
	config: Config,
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
	const promise = run().finally(() => {
		pending?.delete(key);
	});
	pending.set(key, promise);
	return promise;
}

async function fillCold(
	url: string,
	config: Config,
	accept: string,
	request: CacheRequest,
	first: CacheLookup,
	uncached: UncachedFetch,
	allowUrl: UrlGate | undefined,
): Promise<FetchResult> {
	const started = performance.now();
	const lock = await acquireCacheLock(config, first.key);
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
		url,
		lookup.entry,
		lookup.body,
		performance.now() - started,
	);
	return (await cachedAllowed(result, allowUrl)) ? result : undefined;
}

async function cachedAllowed(
	result: FetchResult,
	allowUrl: UrlGate | undefined,
) {
	if (!allowUrl) return true;
	if (result.url === result.finalUrl && (result.redirects?.length ?? 0) === 0)
		return true;
	try {
		return await allowUrl(result.finalUrl);
	} catch {
		return false;
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
		await releaseDirLock(lock);
	}
}
