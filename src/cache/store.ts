import { createHash, randomUUID } from "node:crypto";
import {
	mkdir,
	readFile,
	rename,
	rm,
	stat,
	utimes,
	writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type {
	CacheSummary,
	Config,
	FetchResult,
	RedirectHop,
} from "../core/types.ts";
import { validatePublicHttpUrl } from "../security/url.ts";

const schemaVersion = "docsnap-cache-v1";
const renderMode = "static";
const defaultMaxBytes = 2 * 1024 * 1024 * 1024;
const defaultFreshMs = 6 * 60 * 60 * 1000;
const maxFreshMs = 24 * 60 * 60 * 1000;
const cacheDirEnv = "DOCSNAP_CACHE_DIR";
const cacheMaxEnv = "DOCSNAP_CACHE_MAX_MB";
const allowTestHostEnv = "DOCSNAP_ALLOW_TEST_HOST";
const contexts = new WeakMap<Config, CacheContext>();

export type CacheContext = {
	enabled: boolean;
	dir: string | null;
	maxBytes: number;
	stats: CacheSummary;
};

export type CacheRequest = {
	url: string;
	accept: string;
	userAgent: string;
};

export type CacheEntry = {
	schemaVersion: string;
	key: string;
	requestUrl: string;
	finalUrl: string;
	status: number;
	contentType: string;
	redirects: RedirectHop[];
	etag?: string;
	lastModified?: string;
	cacheControl?: string;
	fetchedAt: string;
	cachedAt: string;
	freshUntil: string;
	bodyHash: string;
	bytes: number;
};

export type CacheLookup =
	| { state: "disabled"; key: string }
	| { state: "miss"; key: string }
	| { state: "fresh" | "stale"; key: string; entry: CacheEntry; body: string };

export type CacheLock = { key: string; path: string };

export function cacheRequest(
	url: string,
	config: Config,
	accept: string,
): CacheRequest {
	return { url, accept, userAgent: config.userAgent };
}

export function cacheKey(request: CacheRequest): string {
	const hash = createHash("sha256");
	for (const part of [
		schemaVersion,
		normalizeCacheUrl(request.url),
		request.accept,
		request.userAgent,
		renderMode,
	]) {
		hash.update(part);
		hash.update("\0");
	}
	return hash.digest("hex");
}

export async function readCache(
	config: Config,
	request: CacheRequest,
	options: { count?: boolean } = {},
): Promise<CacheLookup> {
	const context = cacheContext(config);
	const key = cacheKey(request);
	if (!context.enabled) return { state: "disabled", key };
	const count = options.count !== false;
	try {
		const entryPath = pathFor(context, "entries", `${key}.json`);
		const entry = parseEntry(await readFile(entryPath, "utf8"), key);
		if (!entry || !entrySafe(entry)) {
			if (count) context.stats.misses++;
			await removeEntry(context, key);
			return { state: "miss", key };
		}
		const body = await readFile(blobPath(context, entry.bodyHash), "utf8");
		if (sha256(body) !== entry.bodyHash) {
			if (count) context.stats.misses++;
			await removeEntry(context, key, entry.bodyHash);
			return { state: "miss", key };
		}
		context.stats.bytesRead += byteLength(body);
		void touch(entryPath);
		if (Date.parse(entry.freshUntil) > Date.now()) {
			if (count) context.stats.hits++;
			return { state: "fresh", key, entry, body };
		}
		if (count) context.stats.stale++;
		return { state: "stale", key, entry, body };
	} catch (error) {
		if (count) context.stats.misses++;
		if (!isNotFound(error)) disableOnAccessError(context, error);
		return { state: "miss", key };
	}
}

export async function writeCacheResult(
	config: Config,
	key: string,
	request: CacheRequest,
	result: FetchResult,
): Promise<void> {
	const context = cacheContext(config);
	if (!context.enabled || !result.ok || isNotModifiedResult(result)) return;
	const freshUntil = freshUntilFor(result);
	if (!freshUntil) return;
	const bodyHash = sha256(result.body);
	const bytes = byteLength(result.body);
	const now = new Date().toISOString();
	const entry: CacheEntry = {
		schemaVersion,
		key,
		requestUrl: normalizeCacheUrl(request.url),
		finalUrl: normalizeCacheUrl(result.finalUrl),
		status: result.status,
		contentType: result.contentType,
		redirects: result.redirects ?? [],
		...(result.etag ? { etag: result.etag } : {}),
		...(result.lastModified ? { lastModified: result.lastModified } : {}),
		...(result.cacheControl ? { cacheControl: result.cacheControl } : {}),
		fetchedAt: result.fetchedAt ?? now,
		cachedAt: now,
		freshUntil: freshUntil.toISOString(),
		bodyHash,
		bytes,
	};
	if (!entrySafe(entry)) return;
	try {
		await ensureDirs(context);
		const blob = blobPath(context, bodyHash);
		if (!(await exists(blob))) {
			await atomicWrite(blob, result.body);
			context.stats.bytesWritten += bytes;
		}
		await atomicWrite(
			pathFor(context, "entries", `${key}.json`),
			`${JSON.stringify(entry, null, 2)}\n`,
		);
		context.stats.written++;
	} catch (error) {
		disableOnAccessError(context, error);
	}
}

export async function refreshCacheEntry(
	config: Config,
	key: string,
	entry: CacheEntry,
	result: FetchResult,
): Promise<CacheEntry> {
	const context = cacheContext(config);
	const now = new Date().toISOString();
	const cacheControl = result.cacheControl ?? entry.cacheControl;
	const next: CacheEntry = {
		...entry,
		...(result.etag ? { etag: result.etag } : {}),
		...(result.lastModified ? { lastModified: result.lastModified } : {}),
		...(cacheControl ? { cacheControl } : {}),
		fetchedAt: result.fetchedAt ?? now,
		cachedAt: now,
		freshUntil:
			freshUntilFor(
				cacheResultFromEntry(entry, "", 0, cacheControl),
			)?.toISOString() ?? now,
	};
	try {
		await ensureDirs(context);
		await atomicWrite(
			pathFor(context, "entries", `${key}.json`),
			`${JSON.stringify(next, null, 2)}\n`,
		);
		context.stats.revalidated++;
	} catch (error) {
		disableOnAccessError(context, error);
	}
	return next;
}

export async function acquireCacheLock(
	config: Config,
	key: string,
): Promise<CacheLock | undefined> {
	const context = cacheContext(config);
	if (!context.enabled) return undefined;
	const path = pathFor(context, "locks", `${key}.lock`);
	for (const delay of [0, 25, 50, 100, 150]) {
		if (delay) await Bun.sleep(delay);
		try {
			await mkdir(dirname(path), { recursive: true });
			await mkdir(path);
			return { key, path };
		} catch (error) {
			if (!isAlreadyExists(error)) {
				disableOnAccessError(context, error);
				return undefined;
			}
		}
	}
	return undefined;
}

export async function releaseCacheLock(lock: CacheLock | undefined) {
	if (!lock) return;
	await rm(lock.path, { recursive: true, force: true });
}

export function cachedFetchResult(
	requestUrl: string,
	entry: CacheEntry,
	body: string,
	fetchMs: number,
): FetchResult {
	return cacheResultFromEntry(
		entry,
		body,
		fetchMs,
		entry.cacheControl,
		requestUrl,
	);
}

export function cacheSummary(config: Config): CacheSummary {
	const summary = cacheContext(config).stats;
	return { ...summary };
}

export function cacheConditional(entry: CacheEntry) {
	return {
		...(entry.etag ? { etag: entry.etag } : {}),
		...(entry.lastModified ? { lastModified: entry.lastModified } : {}),
		urls: [entry.requestUrl, entry.finalUrl],
	};
}

export function cacheContext(config: Config): CacheContext {
	const existing = contexts.get(config);
	if (existing) return existing;
	const dir = cacheDir(config);
	const enabled = config.cache && dir !== null;
	const context: CacheContext = {
		enabled,
		dir,
		maxBytes: cacheMaxBytes(),
		stats: {
			enabled,
			dir,
			hits: 0,
			misses: 0,
			stale: 0,
			revalidated: 0,
			written: 0,
			bytesRead: 0,
			bytesWritten: 0,
			evictedBytes: 0,
		},
	};
	contexts.set(config, context);
	return context;
}

function cacheDir(config: Config): string | null {
	if (!config.cache) return null;
	const value = process.env[cacheDirEnv]?.trim();
	if (value?.toLowerCase() === "off") return null;
	if (value) return resolve(value);
	if (process.env[allowTestHostEnv]) return null;
	return join(homedir(), ".cache", "docsnap");
}

function cacheMaxBytes() {
	const value = Number(process.env[cacheMaxEnv]);
	if (Number.isFinite(value) && value > 0)
		return Math.floor(value * 1024 * 1024);
	return defaultMaxBytes;
}

function normalizeCacheUrl(raw: string): string {
	const url = new URL(raw);
	url.username = "";
	url.password = "";
	url.hash = "";
	return url.href;
}

function cacheResultFromEntry(
	entry: CacheEntry,
	body: string,
	fetchMs: number,
	cacheControl?: string,
	requestUrl = entry.requestUrl,
): FetchResult {
	return {
		url: requestUrl,
		finalUrl: entry.finalUrl,
		status: entry.status,
		contentType: entry.contentType,
		body,
		fetchMs,
		redirects: entry.redirects,
		...(entry.etag ? { etag: entry.etag } : {}),
		...(entry.lastModified ? { lastModified: entry.lastModified } : {}),
		fetchedAt: entry.fetchedAt,
		...(cacheControl ? { cacheControl } : {}),
		ok: true,
	};
}

function freshUntilFor(result: FetchResult): Date | undefined {
	if (!result.ok || isNotModifiedResult(result)) return undefined;
	if (result.status < 200 || result.status > 299) return undefined;
	const now = Date.now();
	const cacheControl = result.cacheControl?.toLowerCase();
	if (cacheControl) {
		if (/(?:^|,)\s*no-store\s*(?:,|$)/.test(cacheControl)) return undefined;
		const maxAge = cacheControl.match(
			/(?:^|,)\s*(?:s-maxage|max-age)\s*=\s*(\d+)/,
		)?.[1];
		if (maxAge !== undefined) {
			const ttl = Math.min(Number(maxAge) * 1000, maxFreshMs);
			return new Date(now + ttl);
		}
		return undefined;
	}
	if (/text\/html|text\/plain|markdown|mdx/i.test(result.contentType)) {
		return new Date(now + defaultFreshMs);
	}
	return undefined;
}

function isNotModifiedResult(
	result: FetchResult,
): result is FetchResult & { ok: true; notModified: true } {
	return result.ok && "notModified" in result && result.notModified === true;
}

export function parseEntry(text: string, key: string): CacheEntry | undefined {
	try {
		const value = JSON.parse(text) as Partial<CacheEntry>;
		if (
			value.schemaVersion !== schemaVersion ||
			value.key !== key ||
			typeof value.requestUrl !== "string" ||
			typeof value.finalUrl !== "string" ||
			typeof value.status !== "number" ||
			typeof value.contentType !== "string" ||
			!Array.isArray(value.redirects) ||
			typeof value.fetchedAt !== "string" ||
			typeof value.cachedAt !== "string" ||
			typeof value.freshUntil !== "string" ||
			typeof value.bodyHash !== "string" ||
			typeof value.bytes !== "number"
		) {
			return undefined;
		}
		return value as CacheEntry;
	} catch {
		return undefined;
	}
}

function entrySafe(entry: CacheEntry) {
	return (
		validatePublicHttpUrl(entry.requestUrl) === undefined &&
		validatePublicHttpUrl(entry.finalUrl) === undefined &&
		/^[a-f0-9]{64}$/.test(entry.bodyHash)
	);
}

async function ensureDirs(context: CacheContext) {
	await Promise.all([
		mkdir(pathFor(context, "entries"), { recursive: true }),
		mkdir(pathFor(context, "blobs", "sha256"), { recursive: true }),
		mkdir(pathFor(context, "locks"), { recursive: true }),
	]);
}

export function pathFor(context: CacheContext, ...parts: string[]) {
	if (!context.dir) throw new Error("cache disabled");
	return join(context.dir, ...parts);
}

export function blobPath(context: CacheContext, hash: string) {
	return pathFor(context, "blobs", "sha256", hash);
}

async function atomicWrite(path: string, body: string) {
	await mkdir(dirname(path), { recursive: true });
	const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
	await writeFile(temp, body);
	await rename(temp, path);
}

async function removeEntry(context: CacheContext, key: string, hash?: string) {
	await rm(pathFor(context, "entries", `${key}.json`), { force: true });
	if (hash) await rm(blobPath(context, hash), { force: true });
}

async function exists(path: string) {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}

async function touch(path: string) {
	try {
		const now = new Date();
		await utimes(path, now, now);
	} catch {}
}

function sha256(body: string) {
	return createHash("sha256").update(body).digest("hex");
}

function byteLength(body: string) {
	return Buffer.byteLength(body, "utf8");
}

export function disableOnAccessError(context: CacheContext, error: unknown) {
	if (isNotFound(error) || isAlreadyExists(error)) return;
	context.enabled = false;
	context.stats.enabled = false;
}

export function isNotFound(error: unknown) {
	return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function isAlreadyExists(error: unknown) {
	return error instanceof Error && "code" in error && error.code === "EEXIST";
}
