import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export const dirLockOwnerFile = "owner.json";

const defaultStaleMs = 60_000;

export type DirLock = {
	path: string;
	token: string;
};

type DirLockOwner = {
	pid: number;
	token: string;
	createdAt: string;
};

type DirLockBaseOptions = {
	path: string;
	staleMs?: number;
	ownerFile?: string;
};

type SoftDirLockOptions = DirLockBaseOptions & {
	mode: "soft";
	delaysMs: readonly number[];
	onAccessError: (error: unknown) => void;
};

type HardDirLockOptions = DirLockBaseOptions & {
	mode: "hard";
	waitTimeoutMs: number;
	delaysMs?: readonly number[];
	timeoutMessage?: (path: string) => string;
};

export function acquireDirLock(
	options: SoftDirLockOptions,
): Promise<DirLock | undefined>;
export function acquireDirLock(options: HardDirLockOptions): Promise<DirLock>;
export async function acquireDirLock(
	options: SoftDirLockOptions | HardDirLockOptions,
): Promise<DirLock | undefined> {
	const staleMs = Math.max(0, options.staleMs ?? defaultStaleMs);
	return options.mode === "soft"
		? acquireSoft(options, staleMs)
		: acquireHard(options, staleMs);
}

export async function releaseDirLock(
	lock: DirLock | undefined,
	ownerFile = dirLockOwnerFile,
): Promise<void> {
	if (!lock) return;
	const owner = await readLockOwner(lock.path, ownerFile);
	if (owner?.token !== lock.token) return;
	await rm(lock.path, { recursive: true, force: true });
}

async function acquireSoft(
	options: SoftDirLockOptions,
	staleMs: number,
): Promise<DirLock | undefined> {
	for (const delay of options.delaysMs) {
		if (delay) await Bun.sleep(delay);
		try {
			return await createLock(options.path, options.ownerFile);
		} catch (error) {
			if (!isAlreadyExists(error)) {
				options.onAccessError(error);
				return undefined;
			}
			try {
				await reapStaleLock(options.path, staleMs, options.ownerFile);
			} catch (reapError) {
				options.onAccessError(reapError);
				return undefined;
			}
		}
	}
	return undefined;
}

async function acquireHard(
	options: HardDirLockOptions,
	staleMs: number,
): Promise<DirLock> {
	const started = Date.now();
	const delays = options.delaysMs ?? [0, 25, 50, 100, 150, 250];
	let waits = 0;
	for (;;) {
		try {
			return await createLock(options.path, options.ownerFile);
		} catch (error) {
			if (!isAlreadyExists(error)) throw error;
			await reapStaleLock(options.path, staleMs, options.ownerFile);
		}
		if (Date.now() - started >= Math.max(0, options.waitTimeoutMs)) {
			throw new Error(
				options.timeoutMessage?.(options.path) ??
					`timed out waiting for directory lock: ${options.path}`,
			);
		}
		const delay = delays[Math.min(waits++, delays.length - 1)] ?? 250;
		if (delay) await Bun.sleep(delay);
	}
}

async function createLock(
	path: string,
	ownerFile = dirLockOwnerFile,
): Promise<DirLock> {
	await mkdir(dirname(path), { recursive: true });
	await mkdir(path);
	const token = randomUUID();
	try {
		await writeFile(
			lockOwnerPath(path, ownerFile),
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
}

async function reapStaleLock(
	path: string,
	staleMs: number,
	ownerFile = dirLockOwnerFile,
): Promise<void> {
	let info: Awaited<ReturnType<typeof stat>>;
	try {
		info = await stat(path);
	} catch (error) {
		if (!isNotFound(error)) throw error;
		return;
	}
	const owner = await readLockOwner(path, ownerFile);
	const createdAt = Date.parse(owner?.createdAt ?? "");
	const started = Number.isFinite(createdAt) ? createdAt : info.mtimeMs;
	const ageMs = Date.now() - started;
	if (ageMs < staleMs) return;
	if (owner && isProcessAlive(owner.pid)) return;
	const stalePath = `${path}.reap-${process.pid}-${randomUUID()}`;
	try {
		await rename(path, stalePath);
		await rm(stalePath, { recursive: true, force: true });
	} catch (error) {
		if (!isNotFound(error) && !isAlreadyExists(error)) throw error;
	}
}

async function readLockOwner(
	path: string,
	ownerFile: string,
): Promise<DirLockOwner | undefined> {
	try {
		const value = JSON.parse(
			await readFile(lockOwnerPath(path, ownerFile), "utf8"),
		);
		if (
			typeof value?.pid === "number" &&
			typeof value.token === "string" &&
			typeof value.createdAt === "string"
		) {
			return value as DirLockOwner;
		}
	} catch {}
	return undefined;
}

function lockOwnerPath(path: string, ownerFile: string): string {
	return join(path, ownerFile);
}

function isProcessAlive(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		if (hasErrorCode(error, "ESRCH") || hasErrorCode(error, "EINVAL"))
			return false;
		if (hasErrorCode(error, "EPERM")) return true;
		return false;
	}
}

function isNotFound(error: unknown): boolean {
	return hasErrorCode(error, "ENOENT");
}

function isAlreadyExists(error: unknown): boolean {
	return hasErrorCode(error, "EEXIST");
}

function hasErrorCode(error: unknown, code: string): boolean {
	return error instanceof Error && "code" in error && error.code === code;
}
