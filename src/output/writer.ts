import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, parse, relative, resolve } from "node:path";
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
	if (config.clean) {
		assertSafeCleanDir(outDir, config.outDir);
		await rm(outDir, { recursive: true, force: true });
	}
	await mkdir(outDir, { recursive: true });
}

export async function writePages(
	records: PageRecord[],
	config: Config,
): Promise<void> {
	if (config.dryRun) return;
	await Promise.all(
		records.filter(hasOutputPath).map((record) => writePage(record, config)),
	);
}

export async function writeRunFiles(
	records: PageRecord[],
	summary: RunSummary,
	config: Config,
): Promise<void> {
	if (config.dryRun) return;
	const files: Array<readonly [file: string, body: string]> = [
		[runFiles.manifest, manifestLines(records)],
		[runFiles.summary, summaryJson(summary)],
		[runFiles.agentReadme, agentReadme(records, summary)],
		[runFiles.tree, treeText(records)],
	];
	await Promise.all(
		files.map(([file, body]) =>
			atomicWrite(join(config.outDir, file), body, config.outDir),
		),
	);
	if (config.agentFiles) await installAgentFiles(summary);
}

async function writePage(record: PageOutput, config: Config) {
	const started = performance.now();
	await atomicWrite(
		join(config.outDir, record.outputPath),
		renderPage(record),
		config.outDir,
	);
	record.timings.writeMs = performance.now() - started;
}

async function atomicWrite(path: string, body: string, root: string) {
	const target = resolve(path);
	const base = resolve(root);
	if (!isInsideOrSame(base, target)) {
		throw new Error(`Refusing to write outside output directory: ${path}`);
	}
	await mkdir(dirname(target), { recursive: true });
	const temp = `${target}.${process.pid}.${randomUUID()}.tmp`;
	await writeFile(temp, body);
	await rename(temp, target);
}

function assertSafeCleanDir(outDir: string, raw: string) {
	const root = parse(outDir).root;
	const cwd = resolve(process.cwd());
	const home = resolve(homedir());
	const isCwdOrAncestor = isInsideOrSame(outDir, cwd);
	const isProtectedHomeDir =
		dirname(outDir) === home && protectedHomeDirs.has(basename(outDir));

	if (
		outDir === root ||
		outDir === home ||
		isCwdOrAncestor ||
		isProtectedHomeDir
	) {
		throw new Error(`Refusing to clean unsafe output directory: ${raw}`);
	}
}

function isInsideOrSame(parent: string, child: string) {
	const path = relative(parent, child);
	return path === "" || (!path.startsWith("..") && !parse(path).root);
}
