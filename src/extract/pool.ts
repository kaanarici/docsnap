import type { FetchedUrl } from "../core/types.ts";
import { shouldExtractInWorker } from "./content.ts";
import { type ExtractedPage, extractPage } from "./html.ts";
import { failedRecord } from "./page-record.ts";

type Message =
	| { id: number; page: ExtractedPage }
	| { id: number; error: string };

// A byte threshold still offloads a few unusually large pages.
const workerByteThreshold = 8 * 1024 * 1024;

export async function extractMany(
	inputs: FetchedUrl[],
): Promise<ExtractedPage[]> {
	if (!("Worker" in globalThis))
		return Promise.all(inputs.map(safeExtractPage));

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

	const size = Math.min(heavy.length, 2);
	let next = 0;
	const pool: Worker[] = [];
	// a fatal error in one worker must tear down the siblings too; otherwise they
	// keep draining the queue and hold the event loop open after a failed run
	const terminateAll = () => {
		for (const worker of pool) worker.terminate();
	};

	try {
		const tasks = Array.from({ length: size }, () => {
			const worker = new Worker(new URL("./worker.ts", import.meta.url), {
				type: "module",
			});
			pool.push(worker);
			return new Promise<void>((resolve, reject) => {
				const fail = (error: Error) => {
					terminateAll();
					reject(error);
				};
				worker.onerror = (event) =>
					fail(event.error ?? new Error("extract worker crashed"));
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
					if (!send()) {
						worker.terminate();
						resolve();
					}
				};
				send();

				function send() {
					const job = heavy[next++];
					if (!job) return false;
					worker.postMessage({ id: job.id, input: job.input });
					return true;
				}
			});
		});

		await Promise.all(tasks);
	} finally {
		terminateAll();
	}
	return results;
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
		failedRecord(
			input.result,
			input.source,
			input.metadata,
			message,
			"extract",
			[],
			input.wasSeed,
		),
		{ links: [], media: [] },
		false,
	];
}
