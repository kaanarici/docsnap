import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export const renderLaunchLockOwnerFile = "owner.json";

const defaultStaleMs = 30_000;
const defaultWaitTimeoutMs = 65_000;
const waitDelaysMs = [0, 25, 50, 100, 150, 250] as const;

export type RenderLaunchLock = {
	path: string;
	token: string;
};

export type RenderLaunchLockOptions = {
	path?: string;
	staleMs?: number;
	waitTimeoutMs?: number;
};

type LockOwner = {
	pid: number;
	token: string;
	createdAt: string;
};

export async function acquireRenderLaunchLock(
	options: RenderLaunchLockOptions = {},
): Promise<RenderLaunchLock> {
	const path = options.path ?? defaultRenderLaunchLockPath();
	const staleMs = Math.max(0, options.staleMs ?? defaultStaleMs);
	const waitTimeoutMs = Math.max(
		0,
		options.waitTimeoutMs ?? defaultWaitTimeoutMs,
	);
	const started = Date.now();
	let waits = 0;
	while (true) {
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
				throw error;
			}
			return { path, token };
		} catch (error) {
			if (!isAlreadyExists(error)) throw error;
			await reapStaleLock(path, staleMs);
		}
		if (Date.now() - started >= waitTimeoutMs) {
			throw new Error(`timed out waiting for render launch lock: ${path}`);
		}
		const delay =
			waitDelaysMs[Math.min(waits++, waitDelaysMs.length - 1)] ?? 250;
		await Bun.sleep(delay);
	}
}

export async function releaseRenderLaunchLock(
	lock: RenderLaunchLock | undefined,
) {
	if (!lock) return;
	const owner = await readLockOwner(lock.path);
	if (owner?.token !== lock.token) return;
	await rm(lock.path, { recursive: true, force: true });
}

function defaultRenderLaunchLockPath() {
	return join(tmpdir(), "docsnap-render.lock");
}

async function reapStaleLock(path: string, staleMs: number): Promise<void> {
	let info: Awaited<ReturnType<typeof stat>>;
	try {
		info = await stat(path);
	} catch (error) {
		if (!isNotFound(error)) throw error;
		return;
	}
	const owner = await readLockOwner(path);
	const createdAt = Date.parse(owner?.createdAt ?? "");
	const started = Number.isFinite(createdAt) ? createdAt : info.mtime.getTime();
	if (Date.now() - started < staleMs) return;
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
	return join(path, renderLaunchLockOwnerFile);
}

function isNotFound(error: unknown) {
	return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function isAlreadyExists(error: unknown) {
	return error instanceof Error && "code" in error && error.code === "EEXIST";
}
