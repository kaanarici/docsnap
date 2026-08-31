type LimitOptions<T> = {
	concurrency: number;
	perOrigin: number;
	key: (item: T) => string;
};

export async function awaitWithSignal<T>(
	promise: Promise<T>,
	signal?: AbortSignal,
): Promise<T> {
	if (!signal) return promise;
	signal.throwIfAborted();
	let rejectAbort: (cause?: unknown) => void = () => {};
	const aborted = new Promise<never>((_, reject) => {
		rejectAbort = reject;
	});
	const onAbort = () => rejectAbort(signal.reason);
	signal.addEventListener("abort", onAbort, { once: true });
	try {
		return await Promise.race([promise, aborted]);
	} finally {
		signal.removeEventListener("abort", onAbort);
	}
}

export async function runBounded<T, R>(
	items: T[],
	options: LimitOptions<T>,
	worker: (item: T) => Promise<R>,
): Promise<R[]> {
	const queue = items.map((item, index) => ({ item, index }));
	const results: R[] = [];
	results.length = items.length;
	const activeByKey = new Map<string, number>();
	const waiters: Array<() => void> = [];
	let failure: unknown;
	let failed = false;

	const workers = Array.from(
		{ length: Math.min(options.concurrency, items.length) },
		async () => {
			while (queue.length > 0 && !failed) {
				const next = takeNext();
				if (!next) {
					await waitForSlot();
					continue;
				}
				try {
					results[next.index] = await worker(next.item);
				} catch (error) {
					failure = error;
					failed = true;
				} finally {
					release(options.key(next.item));
				}
			}
		},
	);

	await Promise.all(workers);
	if (failed) throw failure;
	return results;

	function takeNext(): { item: T; index: number } | undefined {
		for (let i = 0; i < queue.length; i++) {
			const next = queue[i]!;
			const key = options.key(next.item);
			if ((activeByKey.get(key) ?? 0) >= options.perOrigin) continue;
			queue.splice(i, 1);
			activeByKey.set(key, (activeByKey.get(key) ?? 0) + 1);
			return next;
		}
		return undefined;
	}

	function release(key: string) {
		const active = (activeByKey.get(key) ?? 1) - 1;
		if (active > 0) activeByKey.set(key, active);
		else activeByKey.delete(key);
		for (const resolve of waiters.splice(0)) resolve();
	}

	function waitForSlot() {
		return new Promise<void>((resolve) => waiters.push(resolve));
	}
}
