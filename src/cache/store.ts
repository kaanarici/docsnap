import { randomUUID } from "node:crypto";
import {
	chmod,
	mkdir,
	open,
	readdir,
	rename,
	rm,
	stat,
	utimes,
	writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { acquireDirLock, type DirLock } from "../core/dir-lock.ts";
import {
	assertSafeRoot,
	assertTrustedMutationPath,
} from "../core/fs-safety.ts";
import {
	isJsonNumber,
	isJsonObject,
	isJsonString,
	type JsonValue,
	parseJsonValue,
} from "../core/json.ts";
import type {
	CacheSummary,
	ConditionalRequest,
	FetchResult,
	PipelineConfig,
	RedirectHop,
} from "../core/types.ts";
import { validatePublicHttpUrl } from "../security/url.ts";
import {
	blobPath,
	entryKeyFromFileName,
	entryPath,
	isCacheHex,
	lockPath,
	pathFor,
} from "./paths.ts";
import { freshUntilFor, isNotModifiedResult } from "./policy.ts";

const schemaVersion = "docsnap-cache-v1";
const renderMode = "static";
const defaultMaxBytes = 2 * 1024 * 1024 * 1024;
const maxEntryBytes = 64 * 1024;
const orphanBatchSize = 4;
const cacheDirEnv = "DOCSNAP_CACHE_DIR";
const cacheMaxEnv = "DOCSNAP_CACHE_MAX_MB";
const allowTestHostEnv = "DOCSNAP_ALLOW_TEST_HOST";
const contexts = new WeakMap<PipelineConfig, CacheContext>();

export type CacheContext = {
	enabled: boolean;
	dir: string | null;
	maxBytes: number;
	stats: CacheSummary;
	ready?: Promise<boolean>;
};

export type CacheRequest = {
	url: string;
	accept: string;
	userAgent: string;
};

export type CacheWriteLock = DirLock & {
	readonly key: string;
	readonly request: CacheRequest;
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

export function cacheRequest(
	url: string,
	config: PipelineConfig,
	accept: string,
): CacheRequest {
	return { url, accept, userAgent: config.userAgent };
}

export function cacheKey(request: CacheRequest): string {
	const hash = new Bun.CryptoHasher("sha256");
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
	config: PipelineConfig,
	request: CacheRequest,
	options: { count?: boolean } = {},
): Promise<CacheLookup> {
	const context = cacheContext(config);
	const key = cacheKey(request);
	if (!(await cacheReady(context))) return { state: "disabled", key };
	const count = options.count !== false;
	try {
		const path = entryPath(context, key);
		const entry = await readCacheEntry(path, key);
		if (!entry || !entrySafe(entry) || entry.bytes > config.maxBytes) {
			if (count) context.stats.misses++;
			await removeEntry(context, key);
			return { state: "miss", key };
		}
		const body = await readBoundedFile(
			blobPath(context, entry.bodyHash),
			config.maxBytes,
			entry.bytes,
		);
		if (sha256(body) !== entry.bodyHash) {
			if (count) context.stats.misses++;
			await removeEntry(context, key, entry.bodyHash);
			return { state: "miss", key };
		}
		context.stats.bytesRead += byteLength(body);
		void touch(path);
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
	config: PipelineConfig,
	lock: CacheWriteLock,
	result: FetchResult,
): Promise<void> {
	const context = cacheContext(config);
	const { key, request } = lock;
	if (!(await cacheReady(context))) return;
	if (!result.ok || isNotModifiedResult(result)) return notStored(context);
	const freshUntil = freshUntilFor(result);
	if (!freshUntil) return notStored(context);
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
		fetchedAt: result.fetchedAt ?? now,
		cachedAt: now,
		freshUntil: freshUntil.toISOString(),
		bodyHash,
		bytes,
	};
	if (result.etag) entry.etag = result.etag;
	if (result.lastModified) entry.lastModified = result.lastModified;
	if (result.cacheControl) entry.cacheControl = result.cacheControl;
	if (!entrySafe(entry)) return notStored(context);
	try {
		const priorHash = await priorBodyHash(context, key);
		const blob = blobPath(context, bodyHash);
		if (!(await exists(blob))) {
			await atomicWrite(blob, result.body);
			context.stats.bytesWritten += bytes;
		}
		await atomicWrite(entryPath(context, key), serializeEntry(entry));
		context.stats.written++;
		if (priorHash && priorHash !== bodyHash) {
			await removeOrphanBlob(context, priorHash);
		}
	} catch (error) {
		disableOnAccessError(context, error);
	}
}

const notStored = (context: CacheContext) => void context.stats.notStored++;

async function priorBodyHash(
	context: CacheContext,
	key: string,
): Promise<string | undefined> {
	try {
		const prior = await readCacheEntry(entryPath(context, key), key);
		return prior?.bodyHash;
	} catch {
		return undefined;
	}
}

async function removeOrphanBlob(context: CacheContext, hash: string) {
	try {
		if (await blobReferenced(context, hash)) return;
		await rm(blobPath(context, hash), { force: true });
	} catch (error) {
		if (!isNotFound(error)) disableOnAccessError(context, error);
	}
}

async function blobReferenced(
	context: CacheContext,
	hash: string,
): Promise<boolean> {
	const dir = pathFor(context, "entries");
	const names = await readdir(dir);
	for (let offset = 0; offset < names.length; offset += orphanBatchSize) {
		const batch = names.slice(offset, offset + orphanBatchSize);
		const entries = await Promise.all(
			batch.flatMap((name) => {
				const key = entryKeyFromFileName(name);
				return key ? [readCacheEntry(join(dir, name), key)] : [];
			}),
		);
		if (entries.some((entry) => entry?.bodyHash === hash)) return true;
	}
	return false;
}

export async function refreshCacheEntry(
	config: PipelineConfig,
	lock: CacheWriteLock,
	entry: CacheEntry,
	result: FetchResult,
): Promise<CacheEntry> {
	const context = cacheContext(config);
	if (!(await cacheReady(context))) return entry;
	if (entry.key !== lock.key)
		throw new Error("Cache entry does not match lock");
	const { key } = lock;
	const now = new Date().toISOString();
	const cacheControl = result.cacheControl ?? entry.cacheControl;
	const refreshResult = cachedFetchResult(entry, "");
	if (cacheControl) refreshResult.cacheControl = cacheControl;
	if (result.ageSeconds) refreshResult.ageSeconds = result.ageSeconds;
	if (result.vary) refreshResult.vary = result.vary;
	if (result.setCookie) refreshResult.setCookie = true;
	const freshUntil = freshUntilFor(refreshResult);
	const next: CacheEntry = {
		...entry,
		fetchedAt: result.fetchedAt ?? now,
		cachedAt: now,
		freshUntil: freshUntil?.toISOString() ?? now,
	};
	if (result.etag) next.etag = result.etag;
	if (result.lastModified) next.lastModified = result.lastModified;
	if (cacheControl) next.cacheControl = cacheControl;
	try {
		if (!freshUntil) {
			await removeEntry(context, key);
			await removeOrphanBlob(context, entry.bodyHash);
			return next;
		}
		await atomicWrite(entryPath(context, key), serializeEntry(next));
		context.stats.revalidated++;
	} catch (error) {
		disableOnAccessError(context, error);
	}
	return next;
}

export async function acquireCacheWriteLock(
	config: PipelineConfig,
	request: CacheRequest,
): Promise<CacheWriteLock | undefined> {
	const context = cacheContext(config);
	if (!(await cacheReady(context))) return undefined;
	const key = cacheKey(request);
	const lock = await acquireDirLock({
		path: lockPath(context, key),
		mode: "soft",
		delaysMs: [0, 25, 50, 100, 150],
		staleMs: 60_000,
		onAccessError: (error) => disableOnAccessError(context, error),
	});
	return lock ? { ...lock, key, request } : undefined;
}

export function cachedFetchResult(
	entry: CacheEntry,
	body: string,
	requestUrl = entry.requestUrl,
): FetchResult {
	const result: FetchResult = {
		url: requestUrl,
		finalUrl: entry.finalUrl,
		status: entry.status,
		contentType: entry.contentType,
		body,
		redirects: entry.redirects,
		fetchedAt: entry.fetchedAt,
		ok: true,
	};
	if (entry.etag) result.etag = entry.etag;
	if (entry.lastModified) result.lastModified = entry.lastModified;
	if (entry.cacheControl) result.cacheControl = entry.cacheControl;
	return result;
}

export function cacheSummary(config: PipelineConfig): CacheSummary {
	const summary = cacheContext(config).stats;
	return { ...summary };
}

export function cacheConditional(entry: CacheEntry) {
	const conditional: ConditionalRequest = {
		urls: [entry.requestUrl, entry.finalUrl],
	};
	if (entry.etag) conditional.etag = entry.etag;
	if (entry.lastModified) conditional.lastModified = entry.lastModified;
	return conditional;
}

export function cacheContext(config: PipelineConfig): CacheContext {
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
			notStored: 0,
			bytesRead: 0,
			bytesWritten: 0,
			evictedBytes: 0,
		},
	};
	contexts.set(config, context);
	context.ready = enabled
		? prepareCache(context).catch((error) => {
				disableOnAccessError(context, error);
				return false;
			})
		: Promise.resolve(false);
	return context;
}

export async function cacheReady(context: CacheContext) {
	return context.enabled && (await context.ready) === true;
}

function cacheDir(config: PipelineConfig): string | null {
	if (!config.cache) return null;
	const value = process.env[cacheDirEnv]?.trim();
	if (value?.toLowerCase() === "off") return null;
	if (value) return safeCacheRoot(resolve(value));
	if (process.env[allowTestHostEnv]) return null;
	return join(homedir(), ".cache", "docsnap");
}

function safeCacheRoot(dir: string): string | null {
	try {
		assertSafeRoot(dir, "unsafe cache root");
		return dir;
	} catch {
		return null;
	}
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

function parseEntry(text: string, key: string): CacheEntry | undefined {
	try {
		const value = parseJsonValue(text);
		if (!isJsonObject(value) || !Array.isArray(value["redirects"])) {
			return undefined;
		}
		const redirects = value["redirects"].map(parseRedirectHop);
		if (
			!isCacheHex(key) ||
			value["schemaVersion"] !== schemaVersion ||
			value["key"] !== key ||
			!isCacheHex(value["key"]) ||
			!isJsonString(value["requestUrl"]) ||
			!isJsonString(value["finalUrl"]) ||
			!isJsonNumber(value["status"]) ||
			!isJsonString(value["contentType"]) ||
			redirects.some((redirect) => redirect === undefined) ||
			!isJsonString(value["fetchedAt"]) ||
			!isJsonString(value["cachedAt"]) ||
			!isJsonString(value["freshUntil"]) ||
			!isCacheHex(value["bodyHash"]) ||
			!isJsonNumber(value["bytes"]) ||
			!Number.isSafeInteger(value["bytes"]) ||
			value["bytes"] < 0
		) {
			return undefined;
		}
		const entry: CacheEntry = {
			schemaVersion,
			key,
			requestUrl: value["requestUrl"],
			finalUrl: value["finalUrl"],
			status: value["status"],
			contentType: value["contentType"],
			redirects: redirects.filter(
				(redirect): redirect is RedirectHop => redirect !== undefined,
			),
			fetchedAt: value["fetchedAt"],
			cachedAt: value["cachedAt"],
			freshUntil: value["freshUntil"],
			bodyHash: value["bodyHash"],
			bytes: value["bytes"],
		};
		if (isJsonString(value["etag"])) entry.etag = value["etag"];
		if (isJsonString(value["lastModified"])) {
			entry.lastModified = value["lastModified"];
		}
		if (isJsonString(value["cacheControl"])) {
			entry.cacheControl = value["cacheControl"];
		}
		return entry;
	} catch {
		return undefined;
	}
}

function parseRedirectHop(value: JsonValue): RedirectHop | undefined {
	if (
		!isJsonObject(value) ||
		!isJsonString(value["from"]) ||
		!isJsonString(value["to"]) ||
		(value["type"] !== "http" &&
			value["type"] !== "refresh" &&
			value["type"] !== "client") ||
		(value["status"] !== undefined && !isJsonNumber(value["status"]))
	) {
		return undefined;
	}
	const redirect: RedirectHop = {
		from: value["from"],
		to: value["to"],
		type: value["type"],
	};
	if (isJsonNumber(value["status"])) redirect.status = value["status"];
	return redirect;
}

export async function readCacheEntry(path: string, key: string) {
	return parseEntry(await readBoundedFile(path, maxEntryBytes), key);
}

async function readBoundedFile(
	path: string,
	maxBytes: number,
	exactBytes?: number,
) {
	const file = await open(path, "r");
	try {
		const info = await file.stat();
		if (
			!info.isFile() ||
			info.size > maxBytes ||
			(exactBytes !== undefined && info.size !== exactBytes)
		) {
			throw new Error(`invalid cache file size: ${path}`);
		}
		return file.readFile({ encoding: "utf8" });
	} finally {
		await file.close();
	}
}

function entrySafe(entry: CacheEntry) {
	return (
		validatePublicHttpUrl(entry.requestUrl) === undefined &&
		validatePublicHttpUrl(entry.finalUrl) === undefined &&
		isCacheHex(entry.key) &&
		isCacheHex(entry.bodyHash)
	);
}

async function prepareCache(context: CacheContext) {
	const root = pathFor(context);
	await assertTrustedMutationPath(root, "untrusted cache path");
	await mkdir(root, { recursive: true, mode: 0o700 });
	const dirs = [
		root,
		pathFor(context, "entries"),
		pathFor(context, "blobs"),
		pathFor(context, "blobs", "sha256"),
		pathFor(context, "locks"),
	];
	for (const dir of dirs) {
		await mkdir(dir, { recursive: true, mode: 0o700 });
		await assertTrustedMutationPath(dir, "untrusted cache path");
		await chmod(dir, 0o700);
	}
	return true;
}

async function atomicWrite(path: string, body: string) {
	await mkdir(dirname(path), { recursive: true });
	const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
	try {
		await writeFile(temp, body, { flag: "wx", mode: 0o600 });
		await rename(temp, path);
	} finally {
		await rm(temp, { force: true });
	}
}

const serializeEntry = (entry: CacheEntry) =>
	`${JSON.stringify(entry, null, 2)}\n`;

async function removeEntry(context: CacheContext, key: string, hash?: string) {
	await rm(entryPath(context, key), { force: true });
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
	return Bun.CryptoHasher.hash("sha256", body, "hex");
}

function byteLength(body: string) {
	return Buffer.byteLength(body, "utf8");
}

export function disableOnAccessError(context: CacheContext, cause: unknown) {
	if (isNotFound(cause) || isAlreadyExists(cause)) return;
	context.enabled = false;
	context.stats.enabled = false;
}

export function isNotFound(cause: unknown) {
	return cause instanceof Error && "code" in cause && cause.code === "ENOENT";
}

function isAlreadyExists(cause: unknown) {
	return cause instanceof Error && "code" in cause && cause.code === "EEXIST";
}
