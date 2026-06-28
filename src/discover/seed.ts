import type { DiscoveredUrl, PipelineConfig } from "../core/types.ts";
import { canonicalUrlSearch, classifyDiscoveryResource } from "../core/url.ts";
import { isMarkdownLike } from "../extract/content.ts";
import { fetchText } from "../fetch/fetcher.ts";
import { robotsBlockedResult } from "../fetch/result.ts";
import type { Robots } from "./robots.ts";
import { normalizeDiscoveryResourceUrl, normalizeUrl } from "./url.ts";

export function seedInputUrl(raw: string) {
	const resource = classifyDiscoveryResource(raw);
	if (resource) return resource.url;
	const normalized = normalizeUrl(raw) ?? normalizeDiscoveryResourceUrl(raw);
	return normalized ? withRequestedSearch(raw, normalized) : raw;
}

export async function pageOnlyDiscovery(
	config: PipelineConfig,
	inputSeed: string,
	seedRobots: Robots,
): Promise<DiscoveredUrl[]> {
	const pageSeed = withRequestedSearch(config.seedUrl, inputSeed);
	if (!seedRobots.allowed(pageSeed)) {
		return [
			{
				url: pageSeed,
				source: "seed",
				wasSeed: true,
				fetched: robotsBlockedResult(pageSeed),
			},
		];
	}
	const alternate = await markdownAlternateSeed(config, pageSeed, seedRobots);
	if (alternate) return [alternate];
	return [{ url: pageSeed, source: "seed", wasSeed: true }];
}

async function markdownAlternateSeed(
	config: PipelineConfig,
	pageSeed: string,
	seedRobots: Robots,
): Promise<DiscoveredUrl | undefined> {
	const alternate = markdownAlternateUrl(pageSeed);
	if (!alternate || !seedRobots.allowed(alternate)) return;
	const response = await fetchText(
		alternate,
		config,
		"text/markdown,text/plain,*/*;q=0.8",
		undefined,
		(url) =>
			new URL(url).origin === new URL(pageSeed).origin &&
			seedRobots.allowed(url),
	);
	if (!response.ok || !isMarkdownLike(response)) return;
	return { url: alternate, source: "seed", wasSeed: true, fetched: response };
}

function markdownAlternateUrl(raw: string): string | undefined {
	const url = new URL(raw);
	if (url.search || /\.(?:md|mdx|txt)$/i.test(url.pathname)) return;
	url.pathname = url.pathname.endsWith("/")
		? `${url.pathname}index.md`
		: `${url.pathname}.md`;
	return normalizeUrl(url.href);
}

export function seedFirstCorpus(
	seed: DiscoveredUrl,
	corpus: DiscoveredUrl[],
	config: PipelineConfig,
): DiscoveredUrl[] {
	const seedMetadata =
		seed.metadata ?? corpus.find((item) => item.url === seed.url)?.metadata;
	const out: DiscoveredUrl[] = [
		{ ...seed, ...(seedMetadata ? { metadata: seedMetadata } : {}) },
	];
	const seen = new Set([seed.url]);
	for (const item of corpus) {
		if (seen.has(item.url)) continue;
		if (config.maxExplicit && out.length >= config.max) break;
		seen.add(item.url);
		out.push(item);
	}
	return out;
}

export function seedFirstDiscovery(
	config: PipelineConfig,
	discovered: DiscoveredUrl[],
): DiscoveredUrl[] {
	if (
		config.pageOnly ||
		classifyDiscoveryResource(config.seedUrl) ||
		discovered.some((item) => item.wasSeed)
	) {
		return discovered;
	}
	const seed = seedInputUrl(config.seedUrl);
	const seedKey = candidateKey(seed);
	const matched = discovered.findIndex(
		(item) => candidateKey(item.url) === seedKey,
	);
	if (matched >= 0)
		return discovered.map((item, index) =>
			index === matched ? { ...item, wasSeed: true as const } : item,
		);
	return [{ url: seed, source: "seed", wasSeed: true }, ...discovered];
}

function withRequestedSearch(raw: string, normalized: string) {
	try {
		const requested = new URL(raw);
		if (!requested.search) return normalized;
		const seed = new URL(normalized);
		seed.search = requested.search;
		return seed.href;
	} catch {
		return normalized;
	}
}

export function candidateKey(raw: string) {
	const url = new URL(raw);
	url.hash = "";
	const search = canonicalUrlSearch(url);
	url.search = "";
	if (url.pathname !== "/") url.pathname = url.pathname.replace(/\/+$/, "");
	url.pathname = url.pathname.replace(/\.(?:html?|mdx?|txt)$/i, "");
	return `${url.href}${search}`;
}
