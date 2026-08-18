import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
	lstat,
	mkdir,
	open,
	readdir,
	rename,
	rmdir,
	unlink,
	writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import {
	isJsonNumber,
	isJsonObject,
	isJsonString,
	parseJsonValue,
} from "./json.ts";

export const dirLockOwnerFile = "owner.json";
export const dirLockOwnerKind = "docsnap-dir-lock-v1";
const defaultStaleMs = 60_000;
const maxOwnerBytes = 4096;

export type DirLock = {
	path: string;
	token: string;
};

type DirLockOwner = {
	kind: typeof dirLockOwnerKind;
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
	onAccessError: (cause: unknown) => void;
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
	await removeLock(lock.path, ownerFile, owner.token);
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
	await mkdir(path, { mode: 0o700 });
	const token = randomUUID();
	try {
		await writeFile(
			lockOwnerPath(path, ownerFile),
			`${JSON.stringify({
				kind: dirLockOwnerKind,
				pid: process.pid,
				token,
				createdAt: new Date().toISOString(),
			})}\n`,
			{ flag: "wx", mode: 0o600 },
		);
	} catch (error) {
		await unlink(lockOwnerPath(path, ownerFile)).catch(() => {});
		await rmdir(path).catch(() => {});
		throw error;
	}
	return { path, token };
}

async function reapStaleLock(
	path: string,
	staleMs: number,
	ownerFile = dirLockOwnerFile,
): Promise<void> {
	const owner = await readLockOwner(path, ownerFile);
	if (owner) {
		if (!isProcessAlive(owner.pid)) {
			await removeLock(path, ownerFile, owner.token);
		}
		return;
	}
	let info: Awaited<ReturnType<typeof lstat>>;
	try {
		info = await lstat(path);
	} catch (error) {
		if (!isNotFound(error)) throw error;
		return;
	}
	if (Date.now() - info.mtimeMs < staleMs) return;
	await removeLock(path, ownerFile);
}

async function readLockOwner(
	path: string,
	ownerFile: string,
): Promise<DirLockOwner | undefined> {
	try {
		if (!(await lstat(path)).isDirectory()) return undefined;
	} catch {
		return undefined;
	}
	let handle: Awaited<ReturnType<typeof open>>;
	try {
		handle = await open(
			lockOwnerPath(path, ownerFile),
			constants.O_RDONLY | constants.O_NOFOLLOW,
		);
	} catch {
		return undefined;
	}
	try {
		const info = await handle.stat();
		if (!info.isFile() || info.size > maxOwnerBytes) return undefined;
		const body = Buffer.allocUnsafe(maxOwnerBytes + 1);
		const { bytesRead } = await handle.read(body, 0, body.length, 0);
		if (bytesRead > maxOwnerBytes) return undefined;
		const value = parseJsonValue(body.subarray(0, bytesRead).toString("utf8"));
		if (
			isJsonObject(value) &&
			value["kind"] === dirLockOwnerKind &&
			isJsonNumber(value["pid"]) &&
			Number.isInteger(value["pid"]) &&
			value["pid"] > 0 &&
			isJsonString(value["token"]) &&
			/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(value["token"]) &&
			isJsonString(value["createdAt"]) &&
			Number.isFinite(Date.parse(value["createdAt"]))
		) {
			return {
				kind: dirLockOwnerKind,
				pid: value["pid"],
				token: value["token"],
				createdAt: value["createdAt"],
			};
		}
		return undefined;
	} catch {
		return undefined;
	} finally {
		await handle.close();
	}
}

async function removeLock(
	path: string,
	ownerFile: string,
	token?: string,
): Promise<void> {
	const removedPath = `${path}.reap-${process.pid}-${randomUUID()}`;
	try {
		await rename(path, removedPath);
	} catch (error) {
		if (isNotFound(error)) return;
		throw error;
	}
	let removed = false;
	try {
		if (!(await lstat(removedPath)).isDirectory()) return;
		const entries = await readdir(removedPath);
		if (token) {
			const movedOwner = await readLockOwner(removedPath, ownerFile);
			if (movedOwner?.token !== token) return;
			if (entries.length !== 1 || entries[0] !== ownerFile) {
				throw new Error(`Directory lock contains unexpected files: ${path}`);
			}
		} else if (entries.length === 0) {
			await rmdir(removedPath);
			removed = true;
			return;
		} else {
			if (entries.length !== 1 || entries[0] !== ownerFile) return;
			const info = await lstat(lockOwnerPath(removedPath, ownerFile));
			if (!info.isFile() || info.size > maxOwnerBytes) return;
		}
		await unlink(lockOwnerPath(removedPath, ownerFile));
		await rmdir(removedPath);
		removed = true;
	} finally {
		if (!removed) await rename(removedPath, path).catch(() => {});
	}
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

function isNotFound(cause: unknown): boolean {
	return hasErrorCode(cause, "ENOENT");
}

function isAlreadyExists(cause: unknown): boolean {
	return hasErrorCode(cause, "EEXIST");
}

function hasErrorCode(cause: unknown, code: string): boolean {
	return cause instanceof Error && "code" in cause && cause.code === code;
}
