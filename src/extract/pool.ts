import { cpus } from "node:os";
import type { FetchedUrl, PageRecord } from "../core/types.ts";
import { shouldExtractInWorker } from "./content.ts";
import { extractPage } from "./html.ts";

type Message =
	| { id: number; record: PageRecord }
	| { id: number; error: string };

export async function extractMany(inputs: FetchedUrl[]): Promise<PageRecord[]> {
	if (typeof Worker === "undefined")
		return Promise.all(inputs.map(extractPage));

	const results: PageRecord[] = new Array(inputs.length);
	const heavy: Array<{ id: number; input: FetchedUrl }> = [];
	await Promise.all(
		inputs.map(async (input, id) => {
			if (shouldExtractInWorker(input.result)) heavy.push({ id, input });
			else results[id] = await extractPage(input);
		}),
	);
	if (heavy.length < 2) {
		await Promise.all(
			heavy.map(async ({ id, input }) => {
				results[id] = await extractPage(input);
			}),
		);
		return results;
	}

	const size = Math.min(heavy.length, Math.max(1, cpus().length - 1), 8);
	let next = 0;
	const pool: Worker[] = [];
	// a fatal error in one worker must tear down the siblings too; otherwise they
	// keep draining the queue and hold the event loop open after a failed run
	const terminateAll = () => {
		for (const worker of pool) worker.terminate();
	};

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
					fail(new Error(message.error));
					return;
				}
				results[message.id] = message.record;
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
	return results;
}
