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
import {
	basename,
	dirname,
	isAbsolute,
	join,
	parse,
	relative,
	resolve,
} from "node:path";
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
	if (config.dryRun) return;
	const outDir = resolve(config.outDir);
	assertSafeOutputDir(outDir, config.outDir);
	if (config.clean) {
		assertSafeCleanDir(outDir, config.outDir);
		await rm(outDir, { recursive: true, force: true });
	}
	await assertSafeOutputRoot(outDir, config.outDir);
	await mkdir(outDir, { recursive: true });
	await assertSafeOutputRoot(outDir, config.outDir);
}

export async function writePages(
	records: PageRecord[],
	config: Config,
): Promise<WriteStats> {
	if (config.dryRun) return { pageWrites: 0, skippedWrites: 0 };
	const stats: WriteStats = { pageWrites: 0, skippedWrites: 0 };
	await runWrites(records.filter(hasOutputPath), async (record) => {
		const wrote = await writePage(record, config);
		if (wrote) stats.pageWrites++;
		else stats.skippedWrites++;
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
	if (!isInsideOrSame(base, target)) {
		throw new Error(`Refusing to write outside output directory: ${path}`);
	}
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
	if (!(await realPathIsInside(base, parent))) {
		throw new Error(`Refusing to write outside output directory: ${raw}`);
	}
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

function isInsideOrSame(parent: string, child: string) {
	const path = relative(parent, child);
	return path === "" || (!path.startsWith("..") && !parse(path).root);
}

async function realPathIsInside(root: string, target: string) {
	let current = resolve(target);
	for (;;) {
		try {
			return isInsideOrSame(root, await realpath(current));
		} catch (error) {
			if (!(error instanceof Error) || !("code" in error)) throw error;
			if (error.code !== "ENOENT") throw error;
			const next = dirname(current);
			if (next === current) return false;
			current = next;
		}
	}
}
