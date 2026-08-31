import { constants } from "node:fs";
import { open, realpath, stat } from "node:fs/promises";
import { isInsideOrSame, resolveSafeRelativePath } from "../core/fs-safety.ts";

export const corpusLimits = {
	summaryBytes: 2 * 1024 * 1024,
	manifestBytes: 16 * 1024 * 1024,
	pageBytes: 2 * 1024 * 1024,
};

export async function readBoundedCorpusFile(
	outputDir: string,
	outputPath: string,
	maxBytes: number,
): Promise<string> {
	const realOutputDir = await realpathOrMessage(
		outputDir,
		"output_dir does not exist",
	);
	const file = await corpusFile(outputDir, realOutputDir, outputPath, maxBytes);
	let handle: Awaited<ReturnType<typeof open>>;
	try {
		handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
	} catch {
		throw new Error(`Corpus file could not be read: ${outputPath}`);
	}
	try {
		const [opened, currentFile] = await Promise.all([
			handle.stat(),
			realpathOrMessage(
				resolveSafeRelativePath(outputDir, outputPath) ?? "",
				`Corpus file could not be read: ${outputPath}`,
			),
		]);
		if (
			!opened.isFile() ||
			opened.size > maxBytes ||
			currentFile !== file ||
			!isInsideOrSame(realOutputDir, currentFile)
		) {
			throw new Error(
				opened.size > maxBytes
					? readLimitMessage(maxBytes, outputPath)
					: `Corpus file changed while being read: ${outputPath}`,
			);
		}
		const current = await stat(currentFile);
		if (current.dev !== opened.dev || current.ino !== opened.ino) {
			throw new Error(`Corpus file changed while being read: ${outputPath}`);
		}
		const body = await readBoundedHandle(
			handle,
			opened.size,
			maxBytes,
			outputPath,
		);
		const after = await handle.stat();
		if (
			after.dev !== opened.dev ||
			after.ino !== opened.ino ||
			after.size !== opened.size ||
			after.mtimeMs !== opened.mtimeMs
		) {
			throw new Error(`Corpus file changed while being read: ${outputPath}`);
		}
		return body;
	} finally {
		await handle.close();
	}
}

async function readBoundedHandle(
	handle: Awaited<ReturnType<typeof open>>,
	expectedBytes: number,
	maxBytes: number,
	outputPath: string,
): Promise<string> {
	const buffer = Buffer.allocUnsafe(Math.min(maxBytes + 1, expectedBytes + 1));
	let bytesRead = 0;
	for (;;) {
		const read = await handle.read(
			buffer,
			bytesRead,
			buffer.length - bytesRead,
			bytesRead,
		);
		bytesRead += read.bytesRead;
		if (read.bytesRead === 0) break;
		if (bytesRead >= buffer.length) {
			throw new Error(
				bytesRead > maxBytes
					? readLimitMessage(maxBytes, outputPath)
					: `Corpus file changed while being read: ${outputPath}`,
			);
		}
	}
	return buffer.subarray(0, bytesRead).toString("utf8");
}

async function corpusFile(
	outputDir: string,
	realOutputDir: string,
	outputPath: string,
	maxBytes: number,
): Promise<string> {
	const target = resolveSafeRelativePath(outputDir, outputPath);
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
	if (info.size > maxBytes)
		throw new Error(readLimitMessage(maxBytes, outputPath));
	return file;
}

function readLimitMessage(maxBytes: number, outputPath: string): string {
	return `Corpus file exceeds read limit (${Math.ceil(maxBytes / 1024 / 1024)}MB): ${outputPath}`;
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
