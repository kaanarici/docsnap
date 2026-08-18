import { Defuddle } from "defuddle/node";

export type DefuddleParse = {
	content: string;
	title: string;
};

let activeParses = 0;
let restoreStderr: (() => void) | undefined;

export async function parseWithDefuddle(
	document: Document,
	url: string,
): Promise<DefuddleParse | undefined> {
	silenceStderr();
	try {
		const parsed = await Defuddle(document, url, {
			markdown: true,
			useAsync: false,
			debug: false,
		});
		return { content: parsed.content, title: parsed.title };
	} catch {
		return undefined;
	} finally {
		endSilence();
	}
}

function silenceStderr() {
	if (activeParses++ > 0) return;
	const write = process.stderr.write.bind(process.stderr);
	process.stderr.write = discardedStderrWrite;
	restoreStderr = () => {
		process.stderr.write = write;
	};
}

function endSilence() {
	if (--activeParses > 0) return;
	restoreStderr?.();
	restoreStderr = undefined;
}

function discardedStderrWrite(
	_chunk: string | Uint8Array,
	encodingOrCb?: BufferEncoding | ((error?: Error | null) => void),
	cb?: (error?: Error | null) => void,
) {
	finishStderrWrite(encodingOrCb, cb);
	return true;
}

function finishStderrWrite(
	encodingOrCb?: BufferEncoding | ((error?: Error | null) => void),
	cb?: (error?: Error | null) => void,
) {
	if (isWriteCallback(encodingOrCb)) encodingOrCb();
	else cb?.();
}

function isWriteCallback(
	value: BufferEncoding | ((error?: Error | null) => void) | undefined,
): value is (error?: Error | null) => void {
	return typeof value === "function";
}
