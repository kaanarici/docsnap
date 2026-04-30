import type { Config, DiscoveredUrl, FetchResult } from "../core/types.ts";
import { fetchText } from "../fetch/fetcher.ts";
import { discoverPageLinks } from "./nav.ts";
import type { Robots } from "./robots.ts";
import { inScope } from "./url.ts";

export async function crawlScoped(
	seed: string,
	scope: string,
	max: number,
	robots: Robots,
	config: Config,
	first?: FetchResult,
): Promise<DiscoveredUrl[]> {
	const seen = new Set<string>();
	const queued = new Set<string>([seed]);
	const queue = [seed];
	const found: DiscoveredUrl[] = [];

	while (queue.length > 0 && found.length < max) {
		const batch = takeBatch();
		if (batch.length === 0) continue;

		const responses = await Promise.all(
			batch.map((url) =>
				url === seed && first ? first : fetchText(url, config),
			),
		);
		for (const response of responses) {
			if (!response.ok || !response.contentType.toLowerCase().includes("html"))
				continue;
			if (response.finalUrl !== seed) {
				found.push({
					url: response.finalUrl,
					source: "crawl",
					fetched: response,
				});
				if (found.length >= max) break;
			}
			for (const link of discoverPageLinks(response.body, response.finalUrl)) {
				if (
					!seen.has(link) &&
					!queued.has(link) &&
					queue.length + found.length < max * 2
				) {
					queued.add(link);
					queue.push(link);
				}
			}
		}
	}

	return found;

	function takeBatch() {
		const batch: string[] = [];
		const limit = Math.min(config.concurrency, max - found.length);
		while (queue.length > 0 && batch.length < limit) {
			const url = queue.shift()!;
			if (seen.has(url) || !inScope(url, seed, scope) || !robots.allowed(url))
				continue;
			seen.add(url);
			batch.push(url);
		}
		return batch;
	}
}
