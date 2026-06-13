import {
	type ChildProcess,
	type SpawnOptions,
	spawn,
} from "node:child_process";
import { constants } from "node:fs";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import type { Readable, Writable } from "node:stream";
import { acquireDirLock, releaseDirLock } from "../core/dir-lock.ts";
import { CdpConnection } from "./cdp.ts";

export type BrowserBinary = {
	path: string;
	name: string;
};

export type BrowserDiscoveryOptions = {
	env?: Record<string, string | undefined>;
	pathDirs?: string[];
	platform?: NodeJS.Platform;
	exists?: (path: string) => Promise<boolean>;
};

export type BrowserSession = {
	cdp: CdpConnection;
	binary: BrowserBinary;
	product: string;
	close: () => Promise<void>;
};

export type HeadlessMode = "new";

export type BrowserLaunchAttempt = (
	binary: BrowserBinary,
	profile: string,
	headless: HeadlessMode,
) => Promise<BrowserSession>;

export type BrowserProcessSpawner = (
	command: string,
	args: string[],
	options: SpawnOptions,
) => ChildProcess;

export type BrowserLaunchOptions = {
	retries?: number;
	profileRoot?: string;
	retryDelayMs?: (attempt: number) => number;
	launchAttempt?: BrowserLaunchAttempt;
	spawnProcess?: BrowserProcessSpawner;
	launchLockPath?: string;
	launchLockStaleMs?: number;
	launchLockTimeoutMs?: number;
};

type VersionResult = {
	product?: string;
};

const defaultLaunchRetries = 1;
const renderLaunchWaitDelaysMs = [0, 25, 50, 100, 150, 250] as const;

const pathCommands = [
	["google-chrome", "chrome"],
	["chromium", "chromium"],
	["chromium-browser", "chromium"],
	["microsoft-edge", "edge"],
] as const;

export async function findBrowserBinary(
	options: BrowserDiscoveryOptions = {},
): Promise<BrowserBinary | undefined> {
	const env = options.env ?? process.env;
	const platform = options.platform ?? process.platform;
	const exists = options.exists ?? defaultExists;
	for (const key of ["DOCSNAP_CHROME_PATH", "CHROME_PATH"] as const) {
		const value = env[key]?.trim();
		if (value && (await exists(value)))
			return { path: value, name: nameFor(value) };
	}
	const pathDirs =
		options.pathDirs ?? (envValue(env, "PATH") ?? "").split(delimiter);
	for (const [command, name] of pathCommands) {
		for (const dir of pathDirs) {
			if (!dir) continue;
			const path = join(dir, commandForPlatform(command, platform));
			if (await exists(path)) return { path, name };
		}
	}
	for (const candidate of knownBrowserPaths(platform, env)) {
		if (await exists(candidate.path)) return candidate;
	}
	return undefined;
}

export async function launchBrowser(
	binary: BrowserBinary,
	options: BrowserLaunchOptions = {},
): Promise<BrowserSession> {
	const maxRetries = Math.max(
		0,
		Math.floor(options.retries ?? defaultLaunchRetries),
	);
	const profileRoot = options.profileRoot ?? tmpdir();
	const launch =
		options.launchAttempt ??
		((attemptBinary, attemptProfile, headless) =>
			launchBrowserAttempt(
				attemptBinary,
				attemptProfile,
				headless,
				options.spawnProcess ?? spawn,
			));
	let lastError: unknown;
	let launchFailures = 0;
	for (let attempt = 0; attempt <= maxRetries; attempt++) {
		const profile = await mkdtemp(join(profileRoot, "docsnap-render-"));
		try {
			const session = await launchWithLock(
				binary,
				profile,
				"new",
				launch,
				options,
			);
			return withProfileCleanup(session, profile);
		} catch (error) {
			launchFailures++;
			lastError = error;
			await rm(profile, { recursive: true, force: true });
			if (attempt < maxRetries) {
				await Bun.sleep((options.retryDelayMs ?? retryDelayMs)(attempt));
			}
		}
	}
	throw withLaunchFailureCount(lastError, launchFailures);
}

async function launchBrowserAttempt(
	binary: BrowserBinary,
	profile: string,
	headless: HeadlessMode,
	spawnProcess: BrowserProcessSpawner = spawn,
): Promise<BrowserSession> {
	let child: ChildProcess | undefined;
	let cdp: CdpConnection | undefined;
	let closed = false;
	try {
		child = spawnProcess(binary.path, browserLaunchArgs(profile, headless), {
			stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"],
		});
		const toBrowser = child.stdio[3] as Writable;
		const fromBrowser = child.stdio[4] as Readable;
		cdp = new CdpConnection(toBrowser, fromBrowser);
		child.once("exit", (code, signal) =>
			cdp?.close(browserExitError(code, signal)),
		);
		child.once("error", (error) => cdp?.close(error));
		const version = await cdp.send<VersionResult>("Browser.getVersion");
		const connection = cdp;
		return {
			cdp: connection,
			binary,
			product: version.product ?? binary.name,
			close: async () => {
				if (closed) return;
				closed = true;
				try {
					await connection.send("Browser.close", {}, undefined, 1_000);
				} catch {
					// Browser.close can fail after a crash; cleanup below is authoritative.
				}
				connection.close();
				await stopChild(child);
			},
		};
	} catch (error) {
		cdp?.close(errorFrom(error));
		await stopChild(child);
		throw error;
	}
}

export function browserLaunchArgs(
	profile: string,
	headless: HeadlessMode,
): string[] {
	return [
		`--headless=${headless}`,
		"--remote-debugging-pipe",
		`--user-data-dir=${profile}`,
		"--no-first-run",
		"--no-default-browser-check",
		"--disable-extensions",
		"--disable-sync",
		"--disable-background-networking",
		"--dns-prefetch-disable",
		"--disable-preconnect",
		"--no-pings",
		"--disable-gpu",
		"--disable-features=NoStatePrefetch,Prerender2,SpeculationRules,SpeculationRulesPrefetchProxy",
	];
}

async function launchWithLock(
	binary: BrowserBinary,
	profile: string,
	headless: HeadlessMode,
	launch: BrowserLaunchAttempt,
	options: BrowserLaunchOptions,
): Promise<BrowserSession> {
	const lock = await acquireDirLock({
		path: options.launchLockPath ?? defaultRenderLaunchLockPath(),
		mode: "hard",
		staleMs: options.launchLockStaleMs ?? 60_000,
		waitTimeoutMs: options.launchLockTimeoutMs ?? 65_000,
		delaysMs: renderLaunchWaitDelaysMs,
		timeoutMessage: (path) =>
			`timed out waiting for render launch lock: ${path}`,
	});
	try {
		return await launch(binary, profile, headless);
	} finally {
		await releaseDirLock(lock);
	}
}

function defaultRenderLaunchLockPath() {
	return join(tmpdir(), "docsnap-render.lock");
}

function withProfileCleanup(
	session: BrowserSession,
	profile: string,
): BrowserSession {
	let closed = false;
	return {
		...session,
		close: async () => {
			if (closed) return;
			closed = true;
			try {
				await session.close();
			} finally {
				await rm(profile, { recursive: true, force: true });
			}
		},
	};
}

function retryDelayMs(attempt: number) {
	return Math.min(400, 150 * (attempt + 1));
}

function browserExitError(code: number | null, signal: NodeJS.Signals | null) {
	if (signal) return new Error(`browser exited with signal ${signal}`);
	if (code !== null) return new Error(`browser exited with code ${code}`);
	return new Error("browser exited");
}

function errorFrom(error: unknown) {
	return error instanceof Error ? error : new Error(String(error));
}

export function browserLaunchFailureCount(error: unknown) {
	const count = (error as { launchFailures?: unknown } | undefined)
		?.launchFailures;
	return typeof count === "number" && Number.isFinite(count)
		? Math.max(1, Math.floor(count))
		: 1;
}

function withLaunchFailureCount(error: unknown, launchFailures: number) {
	const launchError = errorFrom(error) as Error & { launchFailures?: number };
	Object.defineProperty(launchError, "launchFailures", {
		value: Math.max(1, launchFailures),
		configurable: true,
	});
	return launchError;
}

function commandForPlatform(command: string, platform: NodeJS.Platform) {
	return platform === "win32" ? `${command}.exe` : command;
}

function nameFor(path: string) {
	const lower = path.toLowerCase();
	if (lower.includes("edge")) return "edge";
	if (lower.includes("chromium")) return "chromium";
	return "chrome";
}

async function defaultExists(path: string) {
	try {
		await access(path, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

function knownBrowserPaths(
	platform: NodeJS.Platform,
	env: Record<string, string | undefined>,
): BrowserBinary[] {
	if (platform === "darwin") {
		return [
			{
				path: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
				name: "chrome",
			},
			{
				path: "/Applications/Chromium.app/Contents/MacOS/Chromium",
				name: "chromium",
			},
			{
				path: "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
				name: "edge",
			},
		];
	}
	if (platform === "win32") {
		const roots = [
			envValue(env, "PROGRAMFILES"),
			env["PROGRAMFILES(X86)"],
			envValue(env, "LOCALAPPDATA"),
		].filter((value): value is string => Boolean(value));
		return roots.flatMap((root) => [
			{
				path: join(root, "Google", "Chrome", "Application", "chrome.exe"),
				name: "chrome",
			},
			{
				path: join(root, "Microsoft", "Edge", "Application", "msedge.exe"),
				name: "edge",
			},
		]);
	}
	return [
		{ path: "/usr/bin/google-chrome", name: "chrome" },
		{ path: "/usr/bin/chromium", name: "chromium" },
		{ path: "/usr/bin/chromium-browser", name: "chromium" },
		{ path: "/usr/bin/microsoft-edge", name: "edge" },
	];
}

function envValue(env: Record<string, string | undefined>, key: string) {
	return env[key];
}

async function stopChild(child: ChildProcess | undefined) {
	if (!child || child.exitCode !== null || child.signalCode !== null) return;
	child.kill("SIGKILL");
	await Promise.race([
		new Promise<void>((resolve) => child.once("exit", () => resolve())),
		Bun.sleep(500),
	]);
}
