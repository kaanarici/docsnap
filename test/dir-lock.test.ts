import { describe, expect, test } from "bun:test";
import { lstat, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
	acquireDirLock,
	dirLockOwnerFile,
	dirLockOwnerKind,
	releaseDirLock,
} from "../src/core/dir-lock.ts";
import { tempDir } from "./fixtures.ts";

function acquire(path: string, waitTimeoutMs: number, staleMs?: number) {
	const options: Parameters<typeof acquireDirLock>[0] = {
		path,
		mode: "hard",
		waitTimeoutMs,
	};
	if (staleMs !== undefined) options.staleMs = staleMs;
	if (waitTimeoutMs) options.delaysMs = [0];
	return acquireDirLock(options);
}

async function writeDeadOwner(path: string) {
	await writeFile(
		join(path, dirLockOwnerFile),
		`${JSON.stringify({
			kind: dirLockOwnerKind,
			pid: 2_147_483_647,
			token: "00000000-0000-4000-8000-000000000000",
			createdAt: new Date().toISOString(),
		})}\n`,
	);
}

describe("directory lock ownership", () => {
	test("does not recursively reap an unowned collision", async () => {
		const root = await tempDir("lock-collision");
		const path = join(root, "shared.lock");
		await mkdir(path);
		await writeFile(join(path, "keep.txt"), "keep");
		await expect(acquire(path, 0, 0)).rejects.toThrow(
			"timed out waiting for directory lock",
		);
		expect(await readFile(join(path, "keep.txt"), "utf8")).toBe("keep");
	});

	test.each([
		["empty lock", undefined],
		["interrupted owner write", '{"kind":'],
	])("reaps an old %s", async (_, owner) => {
		const root = await tempDir("recoverable-lock");
		const path = join(root, "shared.lock");
		await mkdir(path);
		if (owner) await writeFile(join(path, dirLockOwnerFile), owner);
		const lock = await acquire(path, 100, 0);
		await releaseDirLock({ ...lock, token: "not-the-owner" });
		expect(await readFile(join(path, dirLockOwnerFile), "utf8")).toContain(
			lock.token,
		);
		await releaseDirLock(lock);
		await expect(lstat(path)).rejects.toHaveProperty("code", "ENOENT");
	});

	test("immediately reaps a valid lock whose owner is definitely dead", async () => {
		const root = await tempDir("dead-lock");
		const path = join(root, "shared.lock");
		await mkdir(path);
		await writeDeadOwner(path);
		const lock = await acquire(path, 100);
		expect(lock.path).toBe(path);
		await releaseDirLock(lock);
	});

	test("does not reap extra files from a lock-shaped directory", async () => {
		const root = await tempDir("lock-extra");
		const path = join(root, "shared.lock");
		await mkdir(path);
		await writeDeadOwner(path);
		await writeFile(join(path, "keep.txt"), "keep");
		await expect(acquire(path, 0)).rejects.toThrow("unexpected files");
		expect(await readFile(join(path, "keep.txt"), "utf8")).toBe("keep");
	});

	test("does not follow a symlinked lock directory", async () => {
		const root = await tempDir("lock-symlink");
		const outside = await tempDir("lock-symlink-target");
		const path = join(root, "shared.lock");
		await writeDeadOwner(outside);
		await symlink(outside, path);
		await expect(acquire(path, 0, 0)).rejects.toThrow(
			"timed out waiting for directory lock",
		);
		expect(await readFile(join(outside, dirLockOwnerFile), "utf8")).toContain(
			dirLockOwnerKind,
		);
	});
});
