import { type ChildProcess, spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import type { Readable, Writable } from "node:stream";
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

type VersionResult = {
	product?: string;
};

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
): Promise<BrowserSession> {
	const profile = await mkdtemp(join(tmpdir(), "docsnap-render-"));
	let child: ChildProcess | undefined;
	let closed = false;
	try {
		child = spawn(
			binary.path,
			[
				"--headless=new",
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
				"--disable-features=NoStatePrefetch,Prerender2,SpeculationRules,SpeculationRulesPrefetchProxy",
			],
			{ stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"] },
		);
		const toBrowser = child.stdio[3] as Writable;
		const fromBrowser = child.stdio[4] as Readable;
		const cdp = new CdpConnection(toBrowser, fromBrowser);
		child.once("exit", () => cdp.close(new Error("browser exited")));
		const version = await cdp.send<VersionResult>("Browser.getVersion");
		return {
			cdp,
			binary,
			product: version.product ?? binary.name,
			close: async () => {
				if (closed) return;
				closed = true;
				try {
					await cdp.send("Browser.close", {}, undefined, 1_000);
				} catch {
					// Browser.close can fail after a crash; cleanup below is authoritative.
				}
				cdp.close();
				await stopChild(child);
				await rm(profile, { recursive: true, force: true });
			},
		};
	} catch (error) {
		await stopChild(child);
		await rm(profile, { recursive: true, force: true });
		throw error;
	}
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
