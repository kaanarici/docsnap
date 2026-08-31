import { maxGeneratedCapturePages } from "../core/config.ts";
import type { DiscoveredUrl, PipelineConfig } from "../core/types.ts";
import { isLlmsResourcePath } from "../core/url.ts";
import { discoverLlms, type LlmsDiscoveryOptions } from "./llms.ts";
import { loadRobots } from "./robots.ts";
import { orderByTopic } from "./topic.ts";
import {
	addDiscovered,
	normalizeUrl,
	pathAllowed,
	pathInScope,
} from "./url.ts";

export type LlmsCorpusOptions = LlmsDiscoveryOptions;

export async function resourceAllowed(url: string, config: PipelineConfig) {
	const robots = await loadRobots(new URL(url).origin, config);
	return robots.allowed(url);
}

export async function discoverLlmsCorpus(
	seed: string,
	sourceSeed: string,
	scope: string,
	config: PipelineConfig,
	options: LlmsCorpusOptions,
	limit = config.max,
) {
	const llmsUrls = await discoverLlms(seed, config, {
		...options,
		allowResource: (url: string) => resourceAllowed(url, config),
		limit: maxGeneratedCapturePages,
	});
	const out: DiscoveredUrl[] = [];
	const seen = new Set<string>();
	const sourceOrigin = new URL(sourceSeed).origin;
	for (const raw of orderByTopic(llmsUrls, sourceSeed, scope)) {
		const url = normalizeUrl(raw);
		if (!url || isLlmsResourcePath(new URL(url).pathname)) continue;
		const parsed = new URL(url);
		if (parsed.origin !== sourceOrigin) continue;
		if (!pathInScope(parsed.pathname, scope) || !pathAllowed(url, config))
			continue;
		if (!(await resourceAllowed(url, config))) continue;
		addDiscovered(out, seen, url, "llms", sourceSeed, scope);
		if (config.maxExplicit && out.length >= limit) break;
	}
	return out;
}
