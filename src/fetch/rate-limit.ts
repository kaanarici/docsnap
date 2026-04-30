type LimitOptions<T> = {
	concurrency: number;
	perOrigin: number;
	key: (item: T) => string;
};

export async function runBounded<T, R>(
	items: T[],
	options: LimitOptions<T>,
	worker: (item: T) => Promise<R>,
): Promise<R[]> {
	const queue = items.map((item, index) => ({ item, index }));
	const results: R[] = new Array(items.length);
	const activeByKey = new Map<string, number>();
	const waiters: Array<() => void> = [];

	const workers = Array.from(
		{ length: Math.min(options.concurrency, items.length) },
		async () => {
			while (queue.length > 0) {
				const next = takeNext();
				if (!next) {
					await waitForSlot();
					continue;
				}
				try {
					results[next.index] = await worker(next.item);
				} finally {
					release(options.key(next.item));
				}
			}
		},
	);

	await Promise.all(workers);
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
