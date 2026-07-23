import { readFile, realpath, stat } from "node:fs/promises";
import { isInsideOrSame } from "../core/fs-safety.ts";
import { resolvePriorOutputPath } from "../output/prior.ts";

export const corpusLimits = {
	summaryBytes: 2 * 1024 * 1024,
	manifestBytes: 16 * 1024 * 1024,
	pageBytes: 2 * 1024 * 1024,
	searchQueryChars: 500,
	searchPages: 2_000,
	searchBytes: 32 * 1024 * 1024,
};

export class CorpusReadLimitError extends Error {}

export async function readBoundedCorpusFile(
	outputDir: string,
	outputPath: string,
	maxBytes: number,
): Promise<string> {
	const base = await realpathOrMessage(outputDir, "output_dir does not exist");
	return readBoundedCorpusFileFromRealRoot(
		outputDir,
		base,
		outputPath,
		maxBytes,
	);
}

export async function readBoundedCorpusFileFromRealRoot(
	outputDir: string,
	realOutputDir: string,
	outputPath: string,
	maxBytes: number,
): Promise<string> {
	const file = await corpusFileFromRealRoot(
		outputDir,
		realOutputDir,
		outputPath,
		maxBytes,
	);
	try {
		return await readFile(file, "utf8");
	} catch {
		throw new Error(`Corpus file could not be read: ${outputPath}`);
	}
}

async function corpusFileFromRealRoot(
	outputDir: string,
	realOutputDir: string,
	outputPath: string,
	maxBytes: number,
): Promise<string> {
	const target = resolvePriorOutputPath({ outDir: outputDir }, outputPath);
	if (!target)
		throw new Error(`Corpus file is not a safe relative path: ${outputPath}`);
	const file = await realpathOrMessage(
		target,
		`Corpus file not found: ${outputPath}`,
	);
	if (!isInsideOrSame(realOutputDir, file)) {
		throw new Error(`Corpus file is not inside output_dir: ${outputPath}`);
	}
	let info: Awaited<ReturnType<typeof stat>>;
	try {
		info = await stat(file);
	} catch {
		throw new Error(`Corpus file could not be inspected: ${outputPath}`);
	}
	if (!info.isFile())
		throw new Error(`Corpus path is not a file: ${outputPath}`);
	if (info.size > maxBytes) {
		throw new CorpusReadLimitError(
			`Corpus file exceeds read limit (${Math.ceil(maxBytes / 1024 / 1024)}MB): ${outputPath}`,
		);
	}
	return file;
}

export async function readOptionalCorpusFileFromRealRoot(
	outputDir: string,
	realOutputDir: string,
	outputPath: string,
	maxBytes: number,
): Promise<string | null> {
	try {
		return await readBoundedCorpusFileFromRealRoot(
			outputDir,
			realOutputDir,
			outputPath,
			maxBytes,
		);
	} catch (error) {
		if (optionalCorpusReadError(error)) return null;
		throw error;
	}
}

function optionalCorpusReadError(error: unknown): boolean {
	return error instanceof Error && error.message.startsWith("Corpus file ");
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
