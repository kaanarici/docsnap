import { availableParallelism } from "node:os";
import type { FetchedUrl } from "../core/types.ts";
import { shouldExtractInWorker } from "./content.ts";
import { type ExtractedPage, extractPage } from "./html.ts";
import { failedRecord } from "./page-record.ts";

type Message =
	| { id: number; page: ExtractedPage }
	| { id: number; error: string };

export type ExtractionPool = {
	extractMany(inputs: FetchedUrl[]): Promise<ExtractedPage[]>;
	close(): Promise<void>;
};

const workerPageThreshold = 48;
const workerByteThreshold = 8 * 1024 * 1024;

export function createExtractionPool(): ExtractionPool {
	const workers: Worker[] = [];
	let activeReject: ((error: Error) => void) | undefined;

	return { extractMany, close };

	async function extractMany(inputs: FetchedUrl[]): Promise<ExtractedPage[]> {
		if (!("Worker" in globalThis))
			return Promise.all(inputs.map(safeExtractPage));
		if (activeReject) {
			throw new Error("extractMany calls must not overlap on one pool");
		}

		const results: ExtractedPage[] = [];
		results.length = inputs.length;
		const heavy: Array<{ id: number; input: FetchedUrl }> = [];
		await Promise.all(
			inputs.map(async (input, id) => {
				if (shouldExtractInWorker(input.result)) heavy.push({ id, input });
				else results[id] = await safeExtractPage(input);
			}),
		);
		const heavyBytes = heavy.reduce(
			(total, { input }) => total + Buffer.byteLength(input.result.body),
			0,
		);
		if (
			heavy.length < workerPageThreshold &&
			heavyBytes < workerByteThreshold &&
			heavy.every(({ input }) => !input.result.document)
		) {
			await Promise.all(
				heavy.map(async ({ id, input }) => {
					results[id] = await safeExtractPage(input);
				}),
			);
			return results;
		}

		const size = Math.min(
			heavy.length,
			Math.max(1, availableParallelism() - 1),
			8,
		);
		while (workers.length < size) workers.push(createWorker());
		let next = 0;
		let pending = heavy.length;
		await new Promise<void>((resolve, reject) => {
			activeReject = reject;
			for (const worker of workers.slice(0, size)) {
				worker.onmessage = (event: MessageEvent<Message>) => {
					const message = event.data;
					if ("error" in message) {
						results[message.id] = failedExtraction(
							inputs[message.id]!,
							message.error,
						);
					} else {
						results[message.id] = message.page;
					}
					pending--;
					if (pending === 0) {
						activeReject = undefined;
						resolve();
					} else {
						send(worker);
					}
				};
				send(worker);
			}

			function send(worker: Worker) {
				const job = heavy[next++];
				if (!job) return;
				const body = Buffer.from(job.input.result.body, "utf8");
				const input = {
					...job.input,
					result: { ...job.input.result, body: "" },
				};
				worker.postMessage({ id: job.id, input, body }, [body.buffer]);
			}
		});
		return results;
	}

	function createWorker() {
		const worker = new Worker(new URL("./worker.ts", import.meta.url), {
			type: "module",
		});
		worker.onerror = (event) => {
			const reject = activeReject;
			activeReject = undefined;
			reject?.(event.error ?? new Error("extract worker crashed"));
		};
		return worker;
	}

	async function close() {
		await Promise.all(workers.map((worker) => worker.terminate()));
	}
}

async function safeExtractPage(input: FetchedUrl): Promise<ExtractedPage> {
	try {
		return await extractPage(input);
	} catch (error) {
		return failedExtraction(input, error);
	}
}

function failedExtraction(input: FetchedUrl, cause: unknown): ExtractedPage {
	const message = cause instanceof Error ? cause.message : String(cause);
	return [
		failedRecord(input.result, input.source, message, "extract", input.wasSeed),
		{ links: [] },
		false,
	];
}
