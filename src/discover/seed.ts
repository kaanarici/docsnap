import { hasMarkdownBody } from "../core/text.ts";
import type {
	ConditionalRequest,
	DiscoveredUrl,
	PipelineConfig,
} from "../core/types.ts";
import { canonicalUrlSearch, classifyDiscoveryResource } from "../core/url.ts";
import { looksLikeAppShell } from "../extract/app-shell.ts";
import { isMarkdownLike } from "../extract/content.ts";
import { fetchText, preferredMarkdownAccept } from "../fetch/fetcher.ts";
import { robotsBlockedResult } from "../fetch/result.ts";
import type { Robots } from "./robots.ts";
import { normalizeDiscoveryResourceUrl, normalizeUrl } from "./url.ts";

// Give native Markdown a brief head start, then overlap its usual miss with HTML.
const markdownProbeHedgeMs = 40;

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
	pageConditional?: ConditionalRequest,
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
	if (config.perOrigin < 2) {
		const alternate = await markdownAlternateSeed(
			config,
			pageSeed,
			seedRobots,
			pageConditional,
		);
		return [
			alternate ??
				(await fetchPageSeed(config, pageSeed, seedRobots, pageConditional)),
		];
	}
	const controller = new AbortController();
	const started: Promise<unknown>[] = [];
	try {
		const alternatePromise = markdownAlternateSeed(
			config,
			pageSeed,
			seedRobots,
			pageConditional,
			controller.signal,
		);
		started.push(alternatePromise);
		const earlyAlternate = await Promise.race([
			alternatePromise,
			Bun.sleep(markdownProbeHedgeMs),
		]);
		if (earlyAlternate) return [earlyAlternate];

		const pagePromise = fetchPageSeed(
			config,
			pageSeed,
			seedRobots,
			pageConditional,
			controller.signal,
		);
		started.push(pagePromise);
		const winner = await Promise.race([
			pagePromise.then((page) => ({ page })),
			alternatePromise.then((alternate) => ({ alternate })),
		]);
		if ("alternate" in winner) {
			return [winner.alternate ?? (await pagePromise)];
		}
		if (usablePageSeed(winner.page)) return [winner.page];
		return [(await alternatePromise) ?? winner.page];
	} finally {
		controller.abort();
		await Promise.allSettled(started);
	}
}

function usablePageSeed(page: DiscoveredUrl) {
	const response = page.fetched;
	return Boolean(
		response?.ok &&
			(response.notModified ||
				(hasMarkdownBody(response.body) && !looksLikeAppShell(response.body))),
	);
}

async function fetchPageSeed(
	config: PipelineConfig,
	pageSeed: string,
	seedRobots: Robots,
	conditional?: ConditionalRequest,
	signal?: AbortSignal,
): Promise<DiscoveredUrl> {
	const fetched = await fetchText(
		pageSeed,
		config,
		preferredMarkdownAccept,
		conditional,
		(url) =>
			new URL(url).origin === new URL(pageSeed).origin &&
			seedRobots.allowed(url),
		signal ? { signal } : undefined,
	);
	return {
		url: pageSeed,
		source: "seed",
		wasSeed: true,
		...(fetched.ok || fetched.error !== "blocked by robots.txt"
			? { fetched }
			: {}),
	};
}

async function markdownAlternateSeed(
	config: PipelineConfig,
	pageSeed: string,
	seedRobots: Robots,
	conditional?: ConditionalRequest,
	signal?: AbortSignal,
): Promise<DiscoveredUrl | undefined> {
	const alternate = markdownAlternateUrl(pageSeed);
	if (!alternate || !seedRobots.allowed(alternate)) return;
	const response = await fetchText(
		alternate,
		config,
		preferredMarkdownAccept,
		conditional,
		(url) =>
			new URL(url).origin === new URL(pageSeed).origin &&
			seedRobots.allowed(url),
		{ followRouteFallbacks: false, ...(signal ? { signal } : {}) },
	);
	if (!response.ok) return;
	if (
		!response.notModified &&
		(!isMarkdownLike(response) || !hasMarkdownBody(response.body))
	)
		return;
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
