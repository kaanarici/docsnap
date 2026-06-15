import { readFile, realpath, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { isInsideOrSame } from "../core/fs-safety.ts";
import { resolvePriorOutputPath } from "../output/prior.ts";

export type McpState = {
	corpora: Set<string>;
	resourceCorpora: Map<string, string>;
};

export const corpusLimits = {
	summaryBytes: 2 * 1024 * 1024,
	manifestBytes: 16 * 1024 * 1024,
	pageBytes: 2 * 1024 * 1024,
	resourceBytes: 2 * 1024 * 1024,
	resourceChars: 25_000,
	searchQueryChars: 500,
	searchPages: 2_000,
	searchBytes: 32 * 1024 * 1024,
	resourceCorpora: 50,
	resourcePagesPerCorpus: 200,
	refreshChangedPages: 200,
};

export class McpReadLimitError extends Error {}

export async function readableCorpusDir(
	outputDir: string,
	knownCorpora: Iterable<string>,
): Promise<string> {
	const target = await realpathOrMessage(
		outputDir,
		"output_dir must point to an existing docsnap corpus under the MCP server cwd or one captured by this server session",
	);
	const cwd = await realpath(process.cwd());
	if (isInsideOrSame(cwd, target)) return target;
	for (const known of knownCorpora) {
		const knownReal = await realpathOrUndefined(known);
		if (knownReal === target) return target;
	}
	throw new Error(
		"output_dir must be under the MCP server cwd or captured by this server session",
	);
}

// capture writes (and with clean:true, rm -rf) a target dir; unlike reads the
// dir need not exist yet, so realpath the deepest existing ancestor (resolving
// symlinks consistently with cwd) and reattach the missing tail before checking
// containment — defeats a symlinked ancestor escaping cwd
export async function writableCorpusDir(outputDir: string): Promise<string> {
	const cwd = await realpath(process.cwd());
	const resolved = await resolveRealPath(resolve(cwd, outputDir));
	if (!isInsideOrSame(cwd, resolved)) {
		throw new Error("output_dir must be under the MCP server cwd");
	}
	return resolved;
}

async function resolveRealPath(target: string): Promise<string> {
	const existing = await realpathOrUndefined(target);
	if (existing !== undefined) return existing;
	const parent = dirname(target);
	if (parent === target) return target;
	return join(await resolveRealPath(parent), basename(target));
}

export async function readBoundedCorpusFile(
	outputDir: string,
	outputPath: string,
	maxBytes: number,
): Promise<string> {
	const target = resolvePriorOutputPath({ outDir: outputDir }, outputPath);
	if (!target)
		throw new Error(`Corpus file is not a safe relative path: ${outputPath}`);
	const [base, file] = await Promise.all([
		realpathOrMessage(outputDir, "output_dir does not exist"),
		realpathOrMessage(target, `Corpus file not found: ${outputPath}`),
	]);
	if (!isInsideOrSame(base, file)) {
		throw new Error(`Corpus file is not inside output_dir: ${outputPath}`);
	}
	let info: Awaited<ReturnType<typeof stat>>;
	try {
		info = await stat(file);
	} catch (error) {
		logDiagnostic(error);
		throw new Error(`Corpus file could not be inspected: ${outputPath}`);
	}
	if (!info.isFile())
		throw new Error(`Corpus path is not a file: ${outputPath}`);
	if (info.size > maxBytes) {
		throw new McpReadLimitError(
			`Corpus file exceeds MCP read limit (${Math.ceil(maxBytes / 1024 / 1024)}MB): ${outputPath}`,
		);
	}
	try {
		return await readFile(file, "utf8");
	} catch (error) {
		logDiagnostic(error);
		throw new Error(`Corpus file could not be read: ${outputPath}`);
	}
}

export function rememberCorpus(state: McpState, outputDir: string): void {
	state.corpora.add(outputDir);
}

export async function resourceTokenForCorpus(
	state: McpState,
	outputDir: string,
): Promise<string> {
	const realOutput = await realpath(outputDir);
	const cwd = await realpath(process.cwd());
	if (isInsideOrSame(cwd, realOutput)) return outputDir;
	for (const [token, existing] of state.resourceCorpora) {
		if ((await realpathOrUndefined(existing)) === realOutput) return token;
	}
	const token = `session-${state.resourceCorpora.size + 1}`;
	state.resourceCorpora.set(token, outputDir);
	return token;
}

export async function corpusForResourceToken(
	state: McpState,
	token: string,
): Promise<string> {
	return (
		state.resourceCorpora.get(token) ?? readableCorpusDir(token, state.corpora)
	);
}

async function realpathOrMessage(
	path: string,
	message: string,
): Promise<string> {
	try {
		return await realpath(path);
	} catch {
		throw new Error(message);
	}
}

async function realpathOrUndefined(path: string): Promise<string | undefined> {
	try {
		return await realpath(path);
	} catch {
		return undefined;
	}
}

export function logDiagnostic(error: unknown): void {
	const message =
		error instanceof Error ? (error.stack ?? error.message) : String(error);
	process.stderr.write(`${message}\n`);
}
