import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { lockPath } from "./paths.ts";
import type { CacheContext } from "./store.ts";

const lockTimeoutMs = 60_000;
const lockOwnerFile = "owner.json";

export type CacheLock = { key: string; path: string; token: string };

export async function acquireCacheLockForContext(
	context: CacheContext,
	key: string,
	onAccessError: (error: unknown) => void,
): Promise<CacheLock | undefined> {
	if (!context.enabled) return undefined;
	const path = lockPath(context, key);
	for (const delay of [0, 25, 50, 100, 150]) {
		if (delay) await Bun.sleep(delay);
		try {
			await mkdir(dirname(path), { recursive: true });
			await mkdir(path);
			const token = randomUUID();
			try {
				await writeFile(
					lockOwnerPath(path),
					`${JSON.stringify({
						pid: process.pid,
						token,
						createdAt: new Date().toISOString(),
					})}\n`,
				);
			} catch (error) {
				await rm(path, { recursive: true, force: true });
				onAccessError(error);
				return undefined;
			}
			return { key, path, token };
		} catch (error) {
			if (!isAlreadyExists(error)) {
				onAccessError(error);
				return undefined;
			}
			await reapStaleLock(path);
		}
	}
	return undefined;
}

export async function releaseCacheLock(lock: CacheLock | undefined) {
	if (!lock) return;
	const owner = await readLockOwner(lock.path);
	if (owner?.token !== lock.token) return;
	await rm(lock.path, { recursive: true, force: true });
}

type LockOwner = {
	pid: number;
	token: string;
	createdAt: string;
};

async function reapStaleLock(path: string): Promise<void> {
	let info: Awaited<ReturnType<typeof stat>>;
	try {
		info = await stat(path);
	} catch (error) {
		if (!isNotFound(error)) throw error;
		return;
	}
	const owner = await readLockOwner(path);
	const createdAt = Date.parse(owner?.createdAt ?? "");
	const started = Number.isFinite(createdAt) ? createdAt : info.mtimeMs;
	if (Date.now() - started < lockTimeoutMs) return;
	const stalePath = `${path}.reap-${process.pid}-${randomUUID()}`;
	try {
		await rename(path, stalePath);
		await rm(stalePath, { recursive: true, force: true });
	} catch (error) {
		if (!isNotFound(error) && !isAlreadyExists(error)) throw error;
	}
}

async function readLockOwner(path: string): Promise<LockOwner | undefined> {
	try {
		const value = JSON.parse(await readFile(lockOwnerPath(path), "utf8"));
		if (
			typeof value?.pid === "number" &&
			typeof value.token === "string" &&
			typeof value.createdAt === "string"
		) {
			return value as LockOwner;
		}
	} catch {}
	return undefined;
}

function lockOwnerPath(path: string) {
	return join(path, lockOwnerFile);
}

function isNotFound(error: unknown) {
	return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function isAlreadyExists(error: unknown) {
	return error instanceof Error && "code" in error && error.code === "EEXIST";
}
