import { randomUUID } from "node:crypto";
import {
	lstat,
	mkdir,
	readdir,
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
	assertTrustedMutationPath,
	isInsideOrSame,
	realPathIsInside,
	resolveSafeRelativePath,
} from "../core/fs-safety.ts";
import { runBounded } from "../core/parallel.ts";
import type {
	InjectionSignal,
	PageOutput,
	PipelineConfig,
	RedirectHop,
	RunRecord,
	RunSummary,
} from "../core/types.ts";
import { corpusLimits } from "../corpus/access.ts";
import { validatePublicHttpUrl } from "../security/url.ts";
import { retiredRunFiles, runFiles } from "./files.ts";
import { type PriorState, readPriorOutput } from "./prior.ts";

export type StagedPages = {
	outputs: PageOutput[];
	skippedWrites: number;
	writes: StagedWrite[];
	cleanStage?: string;
	outDir: string;
};

type StagedWrite = { target: string; temp?: string };

export async function prepareOutput(config: PipelineConfig): Promise<void> {
	assertOutputRootSafe(config);
	if (config.dryRun) return;
	const outDir = resolve(config.outDir);
	await assertSafeOutputRoot(outDir, config.outDir);
	if (config.clean) assertSafeCleanDir(outDir, config.outDir);
	const mutationError = `Refusing externally writable output path: ${config.outDir}`;
	await assertTrustedMutationPath(outDir, mutationError);
	await mkdir(outDir, { recursive: true, mode: 0o700 });
	await assertSafeOutputRoot(outDir, config.outDir);
	await assertTrustedMutationPath(outDir, mutationError);
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
	assertSafeRoot(
		resolve(config.outDir),
		`Refusing to use unsafe output directory: ${config.outDir}`,
	);
}

export async function acquireOutputLock(
	config: PipelineConfig,
): Promise<DirLock | undefined> {
	if (config.dryRun) return undefined;
	const outDir = resolve(config.outDir);
	return acquireDirLock({
		path: join(dirname(outDir), `.${basename(outDir)}.docsnap-lock`),
		mode: "hard",
		waitTimeoutMs: 30_000,
		timeoutMessage: () =>
			`Another docsnap run is writing to ${config.outDir}. Wait for it to finish or choose a different --out.`,
	});
}

export const releaseOutputLock = releaseDirLock;

export async function stagePages(
	outputs: PageOutput[],
	config: PipelineConfig,
): Promise<StagedPages> {
	assertPageOutputs(outputs, config);
	if (config.dryRun) {
		return { outputs, skippedWrites: 0, writes: [], outDir: config.outDir };
	}
	const cleanStage = config.clean ? await createCleanStage(config) : undefined;
	const writes: StagedWrite[] = [];
	const stagedOutputs: PageOutput[] = [];
	let skippedWrites = 0;
	try {
		for (const output of outputs) {
			const started = performance.now();
			const existing = config.clean
				? undefined
				: await readPriorOutput(config, output.outputPath);
			const wrote = existing !== output.rendered;
			if (!wrote) skippedWrites++;
			if (cleanStage) {
				await atomicWrite(
					join(cleanStage, output.outputPath),
					output.rendered,
					cleanStage,
				);
			} else if (wrote) {
				writes.push(
					await stageAtomicWrite(
						join(config.outDir, output.outputPath),
						output.rendered,
						config.outDir,
					),
				);
			}
			stagedOutputs.push({
				...output,
				timings: {
					...output.timings,
					writeMs: performance.now() - started,
				},
			});
		}
		const staged: StagedPages = {
			outputs: stagedOutputs,
			skippedWrites,
			writes,
			outDir: config.outDir,
		};
		if (cleanStage) staged.cleanStage = cleanStage;
		return staged;
	} catch (error) {
		await cleanupStagedWrites(writes);
		if (cleanStage) await rm(cleanStage, { recursive: true, force: true });
		throw error;
	}
}

export async function commitStagedOutput(
	staged: StagedPages,
	records: RunRecord[],
	summary: RunSummary,
	config: PipelineConfig,
): Promise<void> {
	if (config.dryRun) return;
	if (resolve(staged.outDir) !== resolve(config.outDir)) {
		throw new Error("Staged output directory changed before commit");
	}
	const manifest = boundedRunFile(
		runFiles.manifest,
		`${records.map((record) => JSON.stringify(manifestRecord(record))).join("\n")}\n`,
		corpusLimits.manifestBytes,
	);
	const summaryBody = boundedRunFile(
		runFiles.summary,
		`${JSON.stringify(summary, null, 2)}\n`,
		corpusLimits.summaryBytes,
	);
	if (staged.cleanStage) {
		await commitCleanOutput(staged.cleanStage, manifest, summaryBody, config);
		delete staged.cleanStage;
		return;
	}
	for (const [file, body] of [
		[runFiles.manifest, manifest],
		[runFiles.summary, summaryBody],
	] as const) {
		staged.writes.push(
			await stageAtomicWrite(join(config.outDir, file), body, config.outDir),
		);
	}
	await commitWrites(staged.writes, config.outDir);
	staged.writes.length = 0;
	await Promise.all(
		retiredRunFiles.map((file) =>
			rm(join(config.outDir, file), { force: true }).catch(() => {}),
		),
	);
}

export async function discardStagedOutput(staged: StagedPages): Promise<void> {
	await cleanupStagedWrites(staged.writes);
	if (staged.cleanStage)
		await rm(staged.cleanStage, { recursive: true, force: true });
}

export async function stageStalePages(
	staged: StagedPages,
	prior: PriorState,
	config: PipelineConfig,
): Promise<void> {
	if (config.dryRun || config.clean || !prior.enabled) return;
	const currentPaths = new Set(
		staged.outputs.map((record) => record.outputPath),
	);
	const stale = prior.records
		.map((record) => record.outputPath)
		.filter((path) => !currentPaths.has(path));
	if (stale.length === 0) return;
	const realOutputDir = await realpath(config.outDir);
	const removals = await runBounded(
		stale,
		{ concurrency: 64, perOrigin: 64, key: () => "" },
		(path) => stagedRemoval(realOutputDir, path, config),
	);
	staged.writes.push(
		...removals.filter((write): write is StagedWrite => Boolean(write)),
	);
}

function boundedRunFile(file: string, body: string, maxBytes: number) {
	if (Buffer.byteLength(body) > maxBytes)
		throw new Error(`${file} exceeds the supported size`);
	return body;
}

function manifestRecord(record: RunRecord) {
	if (record.ok) {
		const {
			markdown: _markdown,
			timings: _timings,
			rendered: _rendered,
			...fields
		} = record;
		return compactManifestFields(fields);
	}
	const { markdown: _markdown, timings: _timings, ...fields } = record;
	return compactManifestFields(fields);
}

type ManifestCollections = {
	links: string[];
	media?: string[];
	aliases?: string[];
	redirects: RedirectHop[];
	injectionSignals: InjectionSignal[];
	qualityReasons: string[];
};

function compactManifestFields<T extends ManifestCollections>(record: T) {
	const {
		links,
		media = [],
		aliases = [],
		redirects,
		injectionSignals,
		qualityReasons,
		...fields
	} = record;
	const validLinks = publicManifestUrls(links);
	const validMedia = publicManifestUrls(media);
	const boundedLinks = boundedManifestUrls(validLinks);
	const boundedMedia = boundedManifestUrls(validMedia);
	return {
		...fields,
		links: boundedLinks,
		aliases: aliases.length ? aliases : undefined,
		redirects: redirects.length ? redirects : undefined,
		injectionSignals: injectionSignals.length ? injectionSignals : undefined,
		qualityReasons: qualityReasons.length ? qualityReasons : undefined,
		media: boundedMedia.length ? boundedMedia : undefined,
		linksCount:
			boundedLinks.length < validLinks.length ? validLinks.length : undefined,
		linksTruncated: boundedLinks.length < validLinks.length ? true : undefined,
		mediaCount:
			boundedMedia.length < validMedia.length ? validMedia.length : undefined,
		mediaTruncated: boundedMedia.length < validMedia.length ? true : undefined,
	};
}

function publicManifestUrls(values: readonly string[]) {
	return values.filter((value) => !validatePublicHttpUrl(value));
}

function boundedManifestUrls(value: readonly string[]) {
	const output: string[] = [];
	let bytes = 2;
	for (const item of value) {
		const next =
			Buffer.byteLength(JSON.stringify(item)) + (output.length ? 1 : 0);
		if (bytes + next > 1_536) break;
		output.push(item);
		bytes += next;
	}
	return output;
}

async function stagedRemoval(
	realOutputDir: string,
	outputPath: string,
	config: PipelineConfig,
): Promise<StagedWrite | undefined> {
	const target = resolveSafeRelativePath(config.outDir, outputPath);
	if (!target) return;
	let info: Awaited<ReturnType<typeof lstat>>;
	try {
		info = await lstat(target);
	} catch (error) {
		if (isNotFound(error)) return;
		throw error;
	}
	const realParent = await realpath(dirname(target));
	if (!isInsideOrSame(realOutputDir, realParent)) {
		throw new Error(
			`Refusing to remove stale page outside output directory: ${outputPath}`,
		);
	}
	if (!info.isFile() && !info.isSymbolicLink()) {
		throw new Error(`Refusing to remove non-file stale output: ${outputPath}`);
	}
	return { target };
}

async function atomicWrite(path: string, body: string, root: string) {
	const staged = await stageAtomicWrite(path, body, root);
	try {
		await assertSafeParent(dirname(staged.target), resolve(root), path);
		await rename(staged.temp, staged.target);
	} finally {
		await rm(staged.temp, { force: true });
	}
}

async function stageAtomicWrite(
	path: string,
	body: string,
	root: string,
): Promise<StagedWrite & { temp: string }> {
	const target = resolve(path);
	const resolvedRoot = resolve(root);
	assertInsideRoot(
		resolvedRoot,
		target,
		`Refusing to write outside output directory: ${path}`,
	);
	await assertSafeParent(dirname(target), resolvedRoot, path);
	await mkdir(dirname(target), { recursive: true, mode: 0o700 });
	const [realRoot, realParent] = await Promise.all([
		realpath(resolvedRoot),
		realpath(dirname(target)),
	]);
	if (!isInsideOrSame(realRoot, realParent)) {
		throw new Error(`Refusing to write outside output directory: ${path}`);
	}
	const temp = `${target}.${process.pid}.${randomUUID()}.tmp`;
	try {
		await writeFile(temp, body, { flag: "wx", mode: 0o600 });
		await assertSafeParent(dirname(target), resolvedRoot, path);
		return { target, temp };
	} catch (error) {
		await rm(temp, { force: true });
		throw error;
	}
}

function assertPageOutputs(outputs: PageOutput[], config: PipelineConfig) {
	const paths = new Set<string>();
	for (const output of outputs) {
		if (!resolveSafeRelativePath(config.outDir, output.outputPath)) {
			throw new Error(
				`Refusing to write unsafe page path: ${output.outputPath}`,
			);
		}
		if (paths.has(output.outputPath)) {
			throw new Error(
				`Refusing to write duplicate page path: ${output.outputPath}`,
			);
		}
		paths.add(output.outputPath);
		if (Buffer.byteLength(output.rendered) > corpusLimits.pageBytes) {
			throw new Error(
				`Page output exceeds the supported size (${Math.ceil(corpusLimits.pageBytes / 1024 / 1024)}MB): ${output.outputPath}`,
			);
		}
	}
}

async function createCleanStage(config: PipelineConfig): Promise<string> {
	const outDir = resolve(config.outDir);
	const parent = dirname(outDir);
	await assertSafeParent(parent, parent, config.outDir);
	const stage = join(
		parent,
		`.${basename(outDir)}.docsnap-stage-${process.pid}-${randomUUID()}`,
	);
	await mkdir(stage, { mode: 0o700 });
	return stage;
}

async function commitCleanOutput(
	stage: string,
	manifest: string,
	summary: string,
	config: PipelineConfig,
) {
	await atomicWrite(join(stage, runFiles.manifest), manifest, stage);
	await atomicWrite(join(stage, runFiles.summary), summary, stage);
	const outDir = resolve(config.outDir);
	const backup = `${outDir}.backup-${process.pid}-${randomUUID()}`;
	let movedExisting = false;
	try {
		try {
			await rename(outDir, backup);
			movedExisting = true;
		} catch (error) {
			if (!isNotFound(error)) throw error;
		}
		await rename(stage, outDir);
	} catch (error) {
		if (movedExisting) await rename(backup, outDir).catch(() => {});
		throw error;
	}
	if (movedExisting)
		await rm(backup, { recursive: true, force: true }).catch(() => {});
}

async function commitWrites(writes: StagedWrite[], root: string) {
	const committed: Array<StagedWrite & { backup?: string }> = [];
	const resolvedRoot = resolve(root);
	try {
		for (const write of writes) {
			await assertSafeParent(dirname(write.target), resolvedRoot, write.target);
			const backup = `${write.target}.${process.pid}.${randomUUID()}.backup`;
			let info: Awaited<ReturnType<typeof lstat>> | undefined;
			try {
				info = await lstat(write.target);
			} catch (error) {
				if (!isNotFound(error)) throw error;
			}
			if (info && !info.isFile() && !info.isSymbolicLink()) {
				throw new Error(`Refusing to replace non-file output: ${write.target}`);
			}
			if (info) await rename(write.target, backup);
			try {
				if (write.temp) await rename(write.temp, write.target);
			} catch (error) {
				if (info) await rename(backup, write.target).catch(() => {});
				throw error;
			}
			committed.push(info ? { ...write, backup } : write);
		}
	} catch (error) {
		for (const write of committed.reverse()) {
			if (write.temp) await rm(write.target, { force: true }).catch(() => {});
			if (write.backup) {
				await rename(write.backup, write.target).catch(() => {});
			}
		}
		throw error;
	}
	await Promise.all(
		committed.map((write) =>
			write.backup
				? rm(write.backup, { force: true }).catch(() => {})
				: undefined,
		),
	);
	await Promise.all(
		committed.map((write) =>
			write.temp
				? undefined
				: pruneEmptyParents(dirname(write.target), resolvedRoot),
		),
	);
}

async function pruneEmptyParents(start: string, root: string) {
	for (
		let dir = start;
		dir !== root && isInsideOrSame(root, dir);
		dir = dirname(dir)
	) {
		try {
			await rmdir(dir);
		} catch {
			return;
		}
	}
}

async function cleanupStagedWrites(writes: StagedWrite[]) {
	await Promise.all(
		writes.map((write) =>
			write.temp ? rm(write.temp, { force: true }) : undefined,
		),
	);
}

async function assertSafeOutputRoot(outDir: string, raw: string) {
	if (isAbsolute(raw)) return;
	if (!(await realPathIsInside(await realpath(process.cwd()), outDir))) {
		throw new Error(`Refusing to write outside current directory: ${raw}`);
	}
}

async function assertSafeParent(parent: string, root: string, raw: string) {
	await assertRealPathInside(
		await realpath(root),
		parent,
		`Refusing to write outside output directory: ${raw}`,
	);
}

function assertSafeCleanDir(outDir: string, raw: string) {
	if (!isInsideOrSame(outDir, resolve(process.cwd()))) return;
	throw new Error(`Refusing to clean unsafe output directory: ${raw}`);
}

function isNotFound(cause: unknown) {
	return cause instanceof Error && "code" in cause && cause.code === "ENOENT";
}
