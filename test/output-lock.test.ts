import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { buildPipelineConfig, parseArgs } from "../src/cli/args.ts";
import { acquireDirLock, releaseDirLock } from "../src/core/dir-lock.ts";
import { runPipeline } from "../src/core/pipeline.ts";
import { setFetchTransportForTest } from "../src/fetch/fetcher.ts";

function lockPathFor(outDir: string) {
	const resolved = resolve(outDir);
	return `${join(dirname(resolved), `.${basename(resolved)}`)}.docsnap-lock`;
}

function makeConfig(url: string, outDir: string) {
	const parsed = parseArgs([
		url,
		"-m",
		"2",
		"-o",
		outDir,
		"--clean",
		"--quiet",
	]);
	if ("help" in parsed || "version" in parsed) {
		throw new Error("parseArgs returned help/version");
	}
	return buildPipelineConfig(parsed.run);
}

describe("output directory locking", () => {
	beforeAll(() => {
		setFetchTransportForTest(async (input) => {
			const url = String(input);
			if (url.endsWith("/llms.txt") || url.endsWith("/robots.txt"))
				return response(url, 404, "not found", "text/plain");
			if (url.endsWith("/two"))
				return response(
					url,
					200,
					page("Two", "Second documentation page body."),
				);
			return response(
				url,
				200,
				`<html><head><title>Docs</title></head><body><main><h1>Docs</h1><p>Overview prose for the concurrency lock regression suite.</p><nav><a href="/two">Two</a></nav></main></body></html>`,
			);
		});
	});

	afterAll(() => {
		setFetchTransportForTest(undefined);
	});

	test("normal single run succeeds and leaves no lock dir behind", async () => {
		const soloOut = await mkdtemp(join(tmpdir(), "docsnap-lock-solo-"));
		const solo = await runPipeline(
			makeConfig("https://solo.example.com/", soloOut),
		);
		expect(solo.summary.written).toBe(2);
		expect(await missing(lockPathFor(soloOut))).toBe(true);
	});

	test("held lock blocks a second run until released", async () => {
		const holdMs = 750;
		const waitOut = await mkdtemp(join(tmpdir(), "docsnap-lock-wait-"));
		const held = await acquireDirLock({
			path: lockPathFor(waitOut),
			mode: "hard",
			waitTimeoutMs: 2_000,
		});
		const release = (async () => {
			await Bun.sleep(holdMs);
			await releaseDirLock(held);
		})();
		const blockedStart = performance.now();
		const blocked = await runPipeline(
			makeConfig("https://wait.example.com/", waitOut),
		);
		const blockedMs = performance.now() - blockedStart;
		await release;
		expect(blocked.summary.written).toBe(2);
		expect(blockedMs).toBeGreaterThanOrEqual(holdMs - 50);
		expect(await missing(lockPathFor(waitOut))).toBe(true);
	});

	test("simultaneous runs to the same dir serialize into one consistent corpus", async () => {
		const sharedOut = await mkdtemp(join(tmpdir(), "docsnap-lock-shared-"));
		const [a, b] = await Promise.all([
			runPipeline(makeConfig("https://shared.example.com/", sharedOut)),
			runPipeline(makeConfig("https://shared.example.com/", sharedOut)),
		]);
		expect(a.summary.written === 2 && b.summary.written === 2).toBe(true);
		const summary = JSON.parse(
			await readFile(join(sharedOut, "summary.json"), "utf8"),
		);
		const manifest = (await readFile(join(sharedOut, "manifest.jsonl"), "utf8"))
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		expect(manifest).toHaveLength(summary.discovered);
		for (const entry of manifest) {
			if (!entry.outputPath) continue;
			const onDisk = await stat(join(sharedOut, entry.outputPath));
			expect(onDisk.isFile()).toBe(true);
		}
		expect(await missing(lockPathFor(sharedOut))).toBe(true);
	});
});

async function missing(path: string) {
	try {
		await stat(path);
		return false;
	} catch {
		return true;
	}
}

function page(title: string, text: string) {
	return `<html><head><title>${title}</title></head><body><main><h1>${title}</h1><p>${text}</p></main></body></html>`;
}

function response(
	url: string,
	status: number,
	body: string,
	contentType = "text/html",
) {
	return {
		url,
		status,
		headers: {
			get: (name: string) => (name === "content-type" ? contentType : null),
			getSetCookie: () => [],
		},
		body: new TextEncoder().encode(body),
	};
}
