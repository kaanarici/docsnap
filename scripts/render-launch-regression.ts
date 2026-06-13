import type { ChildProcess, SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import {
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import {
	acquireDirLock,
	dirLockOwnerFile,
	releaseDirLock,
} from "../src/core/dir-lock.ts";
import {
	type BrowserProcessSpawner,
	type BrowserSession,
	type HeadlessMode,
	launchBrowser,
} from "../src/render/browser.ts";
import { CdpConnection } from "../src/render/cdp.ts";

await oldHeadlessPreferenceRegression();
await newHeadlessFallbackRegression();
await launchLockSerializationRegression();
await staleLaunchLockRegression();
await livePidStaleLaunchLockRegression();
await deadPidStaleLaunchLockRegression();
await launchLockReleaseOnFailureRegression();

async function oldHeadlessPreferenceRegression() {
	const root = await mkdtemp(join(tmpdir(), "docsnap-headless-old-"));
	const args: string[][] = [];
	const session = await launchBrowser(
		{ path: "/mock/chrome-old-preferred", name: "chrome" },
		{
			profileRoot: root,
			retries: 0,
			launchLockPath: join(root, "launch.lock"),
			spawnProcess: fakeChromeSpawn(args),
		},
	);
	assert(args.length === 1);
	assert(args[0]?.includes("--headless=old"));
	assert(args[0]?.includes("--disable-gpu"));
	await session.close();
	await assertNoEntries(root);
}

async function newHeadlessFallbackRegression() {
	const root = await mkdtemp(join(tmpdir(), "docsnap-headless-new-"));
	const modes: HeadlessMode[] = [];
	const session = await launchBrowser(
		{ path: "/mock/chrome-old-unsupported", name: "chrome" },
		{
			profileRoot: root,
			retries: 0,
			launchLockPath: join(root, "launch.lock"),
			launchAttempt: async (_binary, _profile, headless) => {
				modes.push(headless);
				if (headless === "old")
					throw new Error("Old Headless mode has been removed");
				return fakeBrowserSession();
			},
		},
	);
	assert(modes.join(",") === "old,new");
	await session.close();
	await assertNoEntries(root);
}

async function launchLockSerializationRegression() {
	const root = await mkdtemp(join(tmpdir(), "docsnap-launch-lock-"));
	const lockPath = join(root, "launch.lock");
	let active = 0;
	let maxActive = 0;
	let calls = 0;
	let enteredFirst = () => {};
	let releaseFirst = () => {};
	const firstEntered = new Promise<void>((resolve) => {
		enteredFirst = resolve;
	});
	const firstReleased = new Promise<void>((resolve) => {
		releaseFirst = resolve;
	});
	const launcher = async () => {
		const call = ++calls;
		active++;
		maxActive = Math.max(maxActive, active);
		if (call === 1) {
			enteredFirst();
			await firstReleased;
		}
		active--;
		return fakeBrowserSession();
	};
	const first = launchBrowser(
		{ path: "/mock/chrome-serialized", name: "chrome" },
		{
			profileRoot: root,
			retries: 0,
			launchLockPath: lockPath,
			launchAttempt: launcher,
		},
	);
	await firstEntered;
	const second = launchBrowser(
		{ path: "/mock/chrome-serialized-second", name: "chrome" },
		{
			profileRoot: root,
			retries: 0,
			launchLockPath: lockPath,
			launchAttempt: launcher,
		},
	);
	await Bun.sleep(25);
	assert(maxActive === 1);
	releaseFirst();
	const sessions = await Promise.all([first, second]);
	assert(maxActive === 1);
	for (const session of sessions) await session.close();
	await assertNoEntries(root);
}

async function staleLaunchLockRegression() {
	const root = await mkdtemp(join(tmpdir(), "docsnap-stale-lock-"));
	const lockPath = join(root, "launch.lock");
	await mkdir(lockPath);
	await writeFile(
		join(lockPath, dirLockOwnerFile),
		`${JSON.stringify({
			pid: 999_999,
			token: "stale",
			createdAt: new Date(Date.now() - 61_000).toISOString(),
		})}\n`,
	);
	let launched = false;
	const session = await launchBrowser(
		{ path: "/mock/chrome-stale-lock", name: "chrome" },
		{
			profileRoot: root,
			retries: 0,
			launchLockPath: lockPath,
			launchLockTimeoutMs: 500,
			launchAttempt: async () => {
				launched = true;
				return fakeBrowserSession();
			},
		},
	);
	assert(launched);
	await session.close();
	await assertNoEntries(root);
}

async function livePidStaleLaunchLockRegression() {
	const root = await mkdtemp(join(tmpdir(), "docsnap-live-stale-lock-"));
	const lockPath = join(root, "launch.lock");
	await mkdir(lockPath);
	await writeFile(
		join(lockPath, dirLockOwnerFile),
		`${JSON.stringify({
			pid: process.pid,
			token: "live",
			createdAt: new Date(Date.now() - 120_000).toISOString(),
		})}\n`,
	);
	try {
		await assertRejects(
			acquireDirLock({
				path: lockPath,
				mode: "hard",
				staleMs: 1,
				waitTimeoutMs: 80,
				timeoutMessage: (path) =>
					`timed out waiting for render launch lock: ${path}`,
			}),
			/timed out waiting for render launch lock/,
		);
		const owner = JSON.parse(
			await readFile(join(lockPath, dirLockOwnerFile), "utf8"),
		) as { token?: string };
		assert(owner.token === "live");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

async function deadPidStaleLaunchLockRegression() {
	const root = await mkdtemp(join(tmpdir(), "docsnap-dead-stale-lock-"));
	const lockPath = join(root, "launch.lock");
	await mkdir(lockPath);
	await writeFile(
		join(lockPath, dirLockOwnerFile),
		`${JSON.stringify({
			pid: 999_999,
			token: "dead",
			createdAt: new Date(Date.now() - 120_000).toISOString(),
		})}\n`,
	);
	const lock = await acquireDirLock({
		path: lockPath,
		mode: "hard",
		staleMs: 1,
		waitTimeoutMs: 500,
	});
	await releaseDirLock(lock);
	await assertNoEntries(root);
}

async function launchLockReleaseOnFailureRegression() {
	const root = await mkdtemp(join(tmpdir(), "docsnap-failed-lock-"));
	const lockPath = join(root, "launch.lock");
	let fail = true;
	const launchAttempt = async () => {
		if (fail) throw new Error("launch race");
		return fakeBrowserSession();
	};
	await assertRejects(
		launchBrowser(
			{ path: "/mock/chrome-failed-lock", name: "chrome" },
			{
				profileRoot: root,
				retries: 0,
				launchLockPath: lockPath,
				launchLockTimeoutMs: 500,
				launchAttempt,
			},
		),
		/launch race/,
	);
	fail = false;
	const session = await launchBrowser(
		{ path: "/mock/chrome-failed-lock", name: "chrome" },
		{
			profileRoot: root,
			retries: 0,
			launchLockPath: lockPath,
			launchLockTimeoutMs: 500,
			launchAttempt,
		},
	);
	await session.close();
	await assertNoEntries(root);
}

function fakeBrowserSession(): BrowserSession {
	const toBrowser = new PassThrough();
	const fromBrowser = new PassThrough();
	const cdp = new CdpConnection(toBrowser, fromBrowser);
	return {
		cdp,
		binary: { path: "/mock/chrome", name: "chrome" },
		product: "mock-chrome",
		close: async () => {
			cdp.close();
			toBrowser.destroy();
			fromBrowser.destroy();
		},
	};
}

function fakeChromeSpawn(calls: string[][]): BrowserProcessSpawner {
	return (_command: string, args: string[], _options: SpawnOptions) => {
		calls.push(args);
		const toBrowser = new PassThrough();
		const fromBrowser = new PassThrough();
		const stderr = new PassThrough();
		const child = new EventEmitter() as ChildProcess;
		const state = child as ChildProcess & MutableChildProcess;
		state.exitCode = null;
		state.signalCode = null;
		state.killed = false;
		state.stdio = [null, null, stderr, toBrowser, fromBrowser];
		state.kill = (signal?: NodeJS.Signals | number) => {
			state.killed = true;
			exit(
				signal === "SIGKILL" ? null : 0,
				signal === "SIGKILL" ? "SIGKILL" : null,
			);
			return true;
		};
		let buffer = "";
		toBrowser.on("data", (chunk: Buffer) => {
			buffer += chunk.toString("utf8");
			let zero = buffer.indexOf("\0");
			while (zero >= 0) {
				const raw = buffer.slice(0, zero);
				buffer = buffer.slice(zero + 1);
				zero = buffer.indexOf("\0");
				if (!raw) continue;
				const command = JSON.parse(raw) as CdpCommand;
				const result =
					command.method === "Browser.getVersion"
						? { product: "Chrome/149.0.0.0" }
						: {};
				fromBrowser.write(`${JSON.stringify({ id: command.id, result })}\0`);
				if (command.method === "Browser.close")
					queueMicrotask(() => exit(0, null));
			}
		});
		function exit(code: number | null, signal: NodeJS.Signals | null) {
			if (state.exitCode !== null || state.signalCode !== null) return;
			state.exitCode = code;
			state.signalCode = signal;
			toBrowser.destroy();
			fromBrowser.destroy();
			stderr.destroy();
			child.emit("exit", code, signal);
		}
		return child;
	};
}

type MutableChildProcess = {
	stdio: Array<PassThrough | null>;
	exitCode: number | null;
	signalCode: NodeJS.Signals | null;
	killed: boolean;
	kill: (signal?: NodeJS.Signals | number) => boolean;
};

type CdpCommand = {
	id: number;
	method: string;
};

async function assertNoEntries(root: string) {
	const entries = await readdir(root);
	assert(entries.length === 0);
}

async function assertRejects(promise: Promise<unknown>, pattern: RegExp) {
	try {
		await promise;
	} catch (error) {
		assert(
			pattern.test(error instanceof Error ? error.message : String(error)),
		);
		return;
	}
	throw new Error("expected rejection");
}

function assert(condition: unknown): asserts condition {
	if (!condition) throw new Error("assertion failed");
}
