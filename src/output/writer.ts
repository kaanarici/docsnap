import { randomUUID } from "node:crypto";
import {
	mkdir,
	readFile,
	realpath,
	rename,
	rm,
	writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, parse, resolve } from "node:path";
import {
	assertInsideRoot,
	assertRealPathInside,
	isInsideOrSame,
	realPathIsInside,
} from "../core/fs-safety.ts";
import { hasOutputPath } from "../core/records.ts";
import type {
	Config,
	PageOutput,
	PageRecord,
	RunSummary,
} from "../core/types.ts";
import { agentReadme, treeText } from "./agent.ts";
import { installAgentFiles } from "./agent-files.ts";
import { runFiles } from "./files.ts";
import { manifestLines, summaryJson } from "./manifest.ts";
import { renderPage } from "./page.ts";

export type WriteStats = {
	pageWrites: number;
	skippedWrites: number;
};

const protectedHomeDirs = new Set([
	"Applications",
	"Desktop",
	"Documents",
	"Downloads",
	"Library",
	"Movies",
	"Music",
	"Pictures",
	"Public",
]);

export async function prepareOutput(config: Config): Promise<void> {
	assertOutputRootSafe(config);
	if (config.dryRun) return;
	const outDir = resolve(config.outDir);
	if (config.clean) {
		assertSafeCleanDir(outDir, config.outDir);
		await rm(outDir, { recursive: true, force: true });
	}
	await assertSafeOutputRoot(outDir, config.outDir);
	await mkdir(outDir, { recursive: true });
	await assertSafeOutputRoot(outDir, config.outDir);
}

export function assertOutputRootSafe(config: Config): void {
	const outDir = resolve(config.outDir);
	assertSafeOutputDir(outDir, config.outDir);
}

export async function writePages(
	records: PageRecord[],
	config: Config,
	onPageDone?: () => void,
): Promise<WriteStats> {
	if (config.dryRun) return { pageWrites: 0, skippedWrites: 0 };
	const stats: WriteStats = { pageWrites: 0, skippedWrites: 0 };
	await runWrites(records.filter(hasOutputPath), async (record) => {
		const wrote = await writePage(record, config);
		if (wrote) stats.pageWrites++;
		else stats.skippedWrites++;
		onPageDone?.();
	});
	return stats;
}

export async function writeRunFiles(
	records: PageRecord[],
	summary: RunSummary,
	config: Config,
): Promise<void> {
	if (config.dryRun) return;
	if (config.agentFiles)
		summary.agentFilesUpdated = await installAgentFiles(summary);
	const files: Array<readonly [file: string, body: string]> = [
		[runFiles.manifest, manifestLines(records)],
		[runFiles.summary, summaryJson(summary)],
		[runFiles.agentReadme, agentReadme(records, summary)],
		[runFiles.tree, treeText(records)],
	];
	await runWrites(files, ([file, body]) =>
		atomicWrite(join(config.outDir, file), body, config.outDir),
	);
}

async function runWrites<T>(
	items: readonly T[],
	write: (item: T) => Promise<void>,
): Promise<void> {
	let index = 0;
	await Promise.all(
		Array.from({ length: Math.min(64, items.length) }, async () => {
			for (;;) {
				const item = items[index++];
				if (!item) return;
				await write(item);
			}
		}),
	);
}

async function writePage(record: PageOutput, config: Config) {
	const started = performance.now();
	const path = join(config.outDir, record.outputPath);
	const body = renderPage(record);
	if ((await existingBody(path)) === body) {
		record.timings.writeMs = performance.now() - started;
		return false;
	}
	await atomicWrite(path, body, config.outDir);
	record.timings.writeMs = performance.now() - started;
	return true;
}

async function existingBody(path: string) {
	try {
		return await readFile(path, "utf8");
	} catch {
		return undefined;
	}
}

async function atomicWrite(path: string, body: string, root: string) {
	const target = resolve(path);
	const base = resolve(root);
	assertInsideRoot(
		base,
		target,
		`Refusing to write outside output directory: ${path}`,
	);
	await assertSafeParent(dirname(target), base, path);
	await mkdir(dirname(target), { recursive: true });
	const [realBase, realParent] = await Promise.all([
		realpath(base),
		realpath(dirname(target)),
	]);
	if (!isInsideOrSame(realBase, realParent)) {
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
	const base = await realpath(root);
	await assertRealPathInside(
		base,
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
	const root = parse(outDir).root;
	const home = resolve(homedir());
	const isProtectedHomeDir =
		dirname(outDir) === home && protectedHomeDirs.has(basename(outDir));
	if (outDir === root || outDir === home || isProtectedHomeDir) {
		throw new Error(`Refusing to use unsafe output directory: ${raw}`);
	}
}
