import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { parseArgs } from "../src/cli/args.ts";
import { acquireDirLock, releaseDirLock } from "../src/core/dir-lock.ts";
import { runPipeline } from "../src/core/pipeline.ts";
import { setFetchTransportForTest } from "../src/fetch/fetcher.ts";

function lockPathFor(outDir: string) {
	const resolved = resolve(outDir);
	return `${join(dirname(resolved), `.${basename(resolved)}`)}.docsnap-lock`;
}

function makeConfig(url: string, outDir: string) {
	const config = parseArgs([
		url,
		"-m",
		"2",
		"-o",
		outDir,
		"--clean",
		"--quiet",
	]);
	assert(!("help" in config) && !("version" in config));
	return config;
}

setFetchTransportForTest(async (input) => {
	const url = String(input);
	if (url.endsWith("/llms.txt") || url.endsWith("/robots.txt"))
		return response(url, 404, "not found", "text/plain");
	if (url.endsWith("/two"))
		return response(url, 200, page("Two", "Second documentation page body."));
	return response(
		url,
		200,
		`<html><head><title>Docs</title></head><body><main><h1>Docs</h1><p>Overview prose for the concurrency lock regression suite.</p><nav><a href="/two">Two</a></nav></main></body></html>`,
	);
});

try {
	// 1. Normal single run succeeds and leaves no lock dir behind.
	const soloOut = await mkdtemp(join(tmpdir(), "docsnap-lock-solo-"));
	const solo = await runPipeline(
		makeConfig("https://solo.example.com/", soloOut),
	);
	assert(solo.summary.written === 2);
	assert(await missing(lockPathFor(soloOut)));

	// 2. A second run must block on a held lock (a concurrent capture) instead of
	//    racing into the same dir; it proceeds only once the holder releases. The hold
	//    window dominates pipeline runtime, so a missing lock would finish far sooner.
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
	assert(blocked.summary.written === 2);
	assert(blockedMs >= holdMs - 50);
	assert(await missing(lockPathFor(waitOut)));

	// 3. Two simultaneous runs to the same dir serialize into one consistent corpus:
	//    summary counts match the manifest and every manifest page exists on disk.
	const sharedOut = await mkdtemp(join(tmpdir(), "docsnap-lock-shared-"));
	const [a, b] = await Promise.all([
		runPipeline(makeConfig("https://shared.example.com/", sharedOut)),
		runPipeline(makeConfig("https://shared.example.com/", sharedOut)),
	]);
	assert(a.summary.written === 2 && b.summary.written === 2);
	const summary = JSON.parse(
		await readFile(join(sharedOut, "summary.json"), "utf8"),
	);
	const manifest = (await readFile(join(sharedOut, "manifest.jsonl"), "utf8"))
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line));
	assert(manifest.length === summary.discovered);
	for (const entry of manifest) {
		if (!entry.outputPath) continue;
		const onDisk = await stat(join(sharedOut, entry.outputPath));
		assert(onDisk.isFile());
	}
	assert(await missing(lockPathFor(sharedOut)));
} finally {
	setFetchTransportForTest(undefined);
}

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

function assert(condition: unknown): asserts condition {
	if (!condition) throw new Error("assertion failed");
}
