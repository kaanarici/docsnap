import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ParsedRun } from "../src/cli/args.ts";
import { buildPipelineConfig, parseArgs } from "../src/cli/args.ts";
import type { PipelineConfig } from "../src/core/types.ts";

export const cacheDirEnv = "DOCSNAP_CACHE_DIR";
export const cacheMaxEnv = "DOCSNAP_CACHE_MAX_MB";

export function config(
	url: string,
	root: string,
	name: string,
	extra: string[] = [],
	pageOnly = true,
): PipelineConfig {
	const args = [url, "-o", join(root, name), "--clean", "--quiet", ...extra];
	if (pageOnly) args.push("--page");
	const parsed = parseArgs(args);
	assertParsedRun(parsed);
	return buildPipelineConfig(parsed.run);
}

export async function withCacheEnv(
	name: string,
	run: (cacheDir: string) => Promise<void>,
) {
	const previousDir = process.env[cacheDirEnv];
	const previousMax = process.env[cacheMaxEnv];
	const cacheDir = await mkdtemp(join(tmpdir(), `docsnap-cache-${name}-`));
	process.env[cacheDirEnv] = cacheDir;
	try {
		await run(cacheDir);
	} finally {
		if (previousDir === undefined) delete process.env[cacheDirEnv];
		else process.env[cacheDirEnv] = previousDir;
		if (previousMax === undefined) delete process.env[cacheMaxEnv];
		else process.env[cacheMaxEnv] = previousMax;
		await rm(cacheDir, { recursive: true, force: true });
	}
}

export async function countEntries(cacheDir: string) {
	try {
		const entries = await readdir(join(cacheDir, "entries"));
		return entries.filter((entry) => entry.endsWith(".json")).length;
	} catch {
		return 0;
	}
}

export function response(
	url: string,
	status: number,
	body: string,
	headers: Record<string, string> = {},
	setCookies: readonly string[] = [],
) {
	const lower = new Map(
		Object.entries({ "content-type": "text/html", ...headers }).map(
			([key, value]) => [key.toLowerCase(), value],
		),
	);
	return {
		url,
		status,
		headers: {
			get: (name: string) => lower.get(name.toLowerCase()) ?? null,
			getSetCookie: () => [...setCookies],
		},
		body: new TextEncoder().encode(body),
	};
}

export function page(title: string, body: string) {
	return `<html><head><title>${title}</title></head><body><main><h1>${title}</h1><p>${body}</p></main></body></html>`;
}

export function assertParsedRun(value: unknown): asserts value is ParsedRun {
	assert(
		typeof value === "object" &&
			value !== null &&
			!("help" in value) &&
			!("version" in value),
	);
}

export function assert(
	condition: unknown,
	message = "assertion failed",
): asserts condition {
	if (!condition) throw new Error(message);
}
