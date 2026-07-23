import { randomUUID } from "node:crypto";
import {
	mkdir,
	readdir,
	readFile,
	realpath,
	rename,
	rm,
	rmdir,
	writeFile,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import {
	acquireDirLock,
	type DirLock,
	releaseDirLock,
} from "../core/dir-lock.ts";
import {
	assertInsideRoot,
	assertRealPathInside,
	assertSafeRoot,
	isInsideOrSame,
	realPathIsInside,
} from "../core/fs-safety.ts";
import { runBounded } from "../core/parallel.ts";
import { hashContent } from "../core/snapshot.ts";
import type {
	PageOutput,
	PipelineConfig,
	RunRecord,
	RunSummary,
} from "../core/types.ts";
import { retiredRunFiles, runFiles } from "./files.ts";
import { type PriorState, resolvePriorOutputPath } from "./prior.ts";

export type WriteStats = {
	pageWrites: number;
	skippedWrites: number;
};

type WriteResult = {
	outputs: PageOutput[];
	stats: WriteStats;
};

export async function prepareOutput(config: PipelineConfig): Promise<void> {
	assertOutputRootSafe(config);
	if (config.dryRun) return;
	const outDir = resolve(config.outDir);
	await assertSafeOutputRoot(outDir, config.outDir);
	if (config.clean) {
		assertSafeCleanDir(outDir, config.outDir);
		await rm(outDir, { recursive: true, force: true });
	}
	await mkdir(outDir, { recursive: true });
	await assertSafeOutputRoot(outDir, config.outDir);
}

export async function outputDirHasContent(outputDir: string): Promise<boolean> {
	const resolvedOutputDir = resolve(outputDir);
	await assertSafeOutputRoot(resolvedOutputDir, outputDir);
	try {
		const entries = await readdir(resolvedOutputDir);
		return entries.some((entry) => entry !== ".DS_Store");
	} catch (error) {
		if (isNotFound(error)) return false;
		throw error;
	}
}

export function assertOutputRootSafe(config: PipelineConfig): void {
	const outDir = resolve(config.outDir);
	assertSafeOutputDir(outDir, config.outDir);
}

export async function acquireOutputLock(
	config: PipelineConfig,
): Promise<DirLock | undefined> {
	if (config.dryRun) return undefined;
	const outDir = resolve(config.outDir);
	return acquireDirLock({
		path: `${join(dirname(outDir), `.${basename(outDir)}`)}.docsnap-lock`,
		mode: "hard",
		waitTimeoutMs: 30_000,
		timeoutMessage: () =>
			`Another docsnap run is writing to ${config.outDir}. Wait for it to finish or choose a different --out.`,
	});
}

export function releaseOutputLock(lock: DirLock | undefined): Promise<void> {
	return releaseDirLock(lock);
}

export async function writePages(
	outputs: PageOutput[],
	config: PipelineConfig,
	onPageDone?: () => void,
): Promise<WriteResult> {
	const stats: WriteStats = { pageWrites: 0, skippedWrites: 0 };
	if (config.dryRun) return { outputs, stats };
	const writtenOutputs = new Array<PageOutput>(outputs.length);
	await runOutputWrites([...outputs.entries()], async ([index, output]) => {
		const { record, wrote } = await writePage(output, config);
		writtenOutputs[index] = record;
		if (wrote) stats.pageWrites++;
		else stats.skippedWrites++;
		onPageDone?.();
	});
	return { outputs: writtenOutputs, stats };
}

export async function removeStalePages(
	prior: PriorState,
	outputs: PageOutput[],
	config: PipelineConfig,
): Promise<void> {
	if (config.dryRun || config.clean) return;
	if (!prior.enabled) return;
	const currentPaths = new Set(outputs.map((record) => record.outputPath));
	const stale = new Set(
		prior.records
			.map((record) => record.outputPath)
			.filter((path) => !currentPaths.has(path)),
	);
	if (stale.size === 0) return;
	const realOutputDir = await realpath(config.outDir);
	await runOutputWrites([...stale], (path) =>
		removeStalePage(realOutputDir, path, config),
	);
}

export async function writeRunFiles(
	records: RunRecord[],
	summary: RunSummary,
	config: PipelineConfig,
): Promise<void> {
	if (config.dryRun) return;
	await atomicWrite(
		join(config.outDir, runFiles.manifest),
		manifestLines(records),
		config.outDir,
	);
	await atomicWrite(
		join(config.outDir, runFiles.summary),
		summaryJson(summary),
		config.outDir,
	);
	await Promise.all(
		retiredRunFiles.map((file) =>
			rm(join(config.outDir, file), { force: true }),
		),
	);
}

function manifestLines(records: RunRecord[]): string {
	return `${records.map((record) => JSON.stringify(manifestRecord(record))).join("\n")}\n`;
}

function summaryJson(summary: RunSummary): string {
	return `${JSON.stringify(summary, null, 2)}\n`;
}

function manifestRecord(record: RunRecord) {
	const entry: Record<string, unknown> = { ...record };
	for (const key of ["markdown", "links", "timings", "rendered"]) {
		delete entry[key];
	}
	if ("rendered" in record) {
		return compactManifestRecord({
			...entry,
			outputHash: hashContent(record.rendered),
		});
	}
	return compactManifestRecord(entry);
}

function compactManifestRecord(entry: Record<string, unknown>) {
	for (const [key, value] of Object.entries(entry)) {
		if (Array.isArray(value) && value.length === 0) delete entry[key];
	}
	return entry;
}

async function runOutputWrites<T>(
	items: readonly T[],
	write: (item: T) => Promise<void>,
): Promise<void> {
	await runBounded(
		[...items],
		{ concurrency: 64, perOrigin: 64, key: () => "" },
		write,
	);
}

async function writePage(record: PageOutput, config: PipelineConfig) {
	const started = performance.now();
	const path = join(config.outDir, record.outputPath);
	const body = record.rendered;
	const wrote = (await readExistingBody(path)) !== body;
	if (wrote) await atomicWrite(path, body, config.outDir);
	const writeMs = performance.now() - started;
	return {
		wrote,
		record: { ...record, timings: { ...record.timings, writeMs } },
	};
}

async function removeStalePage(
	realOutputDir: string,
	outputPath: string,
	config: PipelineConfig,
) {
	const target = resolvePriorOutputPath(config, outputPath);
	if (!target) return;
	let realTarget: string;
	try {
		realTarget = await realpath(target);
	} catch (error) {
		if (isNotFound(error)) return;
		throw error;
	}
	if (!isInsideOrSame(realOutputDir, realTarget)) {
		throw new Error(
			`Refusing to remove stale page outside output directory: ${outputPath}`,
		);
	}
	await rm(realTarget, { force: true });
	await pruneEmptyParents(dirname(realTarget), realOutputDir);
}

async function pruneEmptyParents(start: string, root: string) {
	let dir = start;
	while (dir !== root && isInsideOrSame(root, dir)) {
		try {
			await rmdir(dir);
		} catch (error) {
			if (isNotFound(error) || isNotEmpty(error)) return;
			throw error;
		}
		dir = dirname(dir);
	}
}

async function readExistingBody(path: string) {
	try {
		return await readFile(path, "utf8");
	} catch {
		return undefined;
	}
}

async function atomicWrite(path: string, body: string, root: string) {
	const target = resolve(path);
	const resolvedRoot = resolve(root);
	assertInsideRoot(
		resolvedRoot,
		target,
		`Refusing to write outside output directory: ${path}`,
	);
	await assertSafeParent(dirname(target), resolvedRoot, path);
	await mkdir(dirname(target), { recursive: true });
	const [realRoot, realParent] = await Promise.all([
		realpath(resolvedRoot),
		realpath(dirname(target)),
	]);
	if (!isInsideOrSame(realRoot, realParent)) {
		throw new Error(`Refusing to write outside output directory: ${path}`);
	}
	const temp = `${target}.${process.pid}.${randomUUID()}.tmp`;
	await writeFile(temp, body);
	await rename(temp, target);
}

async function assertSafeOutputRoot(outDir: string, raw: string) {
	if (isAbsolute(raw)) return;
	const cwd = await realpath(process.cwd());
	if (!(await realPathIsInside(cwd, outDir))) {
		throw new Error(`Refusing to write outside current directory: ${raw}`);
	}
}

async function assertSafeParent(parent: string, root: string, raw: string) {
	const realRoot = await realpath(root);
	await assertRealPathInside(
		realRoot,
		parent,
		`Refusing to write outside output directory: ${raw}`,
	);
}

function assertSafeCleanDir(outDir: string, raw: string) {
	const cwd = resolve(process.cwd());
	const isCwdOrAncestor = isInsideOrSame(outDir, cwd);
	if (isCwdOrAncestor) {
		throw new Error(`Refusing to clean unsafe output directory: ${raw}`);
	}
}

function assertSafeOutputDir(outDir: string, raw: string) {
	assertSafeRoot(outDir, `Refusing to use unsafe output directory: ${raw}`);
}

function isNotFound(error: unknown) {
	return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function isNotEmpty(error: unknown) {
	return (
		error instanceof Error &&
		"code" in error &&
		(error.code === "ENOTEMPTY" || error.code === "EEXIST")
	);
}
