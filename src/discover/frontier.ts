import { maxGeneratedCapturePages } from "../core/config.ts";
import type {
	DiscoveredUrl,
	DiscoverySource,
	FetchResult,
	PipelineConfig,
} from "../core/types.ts";
import { type FetchUrlGate, fetchText } from "../fetch/fetcher.ts";
import { filteredNonPageResult } from "../fetch/result.ts";
import { discoverLlmsUrls, type LlmsCorpusOptions } from "./corpus.ts";
import { discoverFeed } from "./feed.ts";
import {
	discoverFetchedResources,
	isHtmlResponse,
	type PageResources,
} from "./nav.ts";
import type { Robots } from "./robots.ts";
import { discoverSitemaps } from "./sitemap.ts";
import { candidateWindow, orderByTopic } from "./topic.ts";
import { addDiscovered, inScope, normalizeUrl } from "./url.ts";

export type DiscoveryFrontierInput = {
	config: PipelineConfig;
	attemptLimit: number;
	inputSeed: string;
	seed: string;
	scope: string;
	robots: Robots;
	allowResource: FetchUrlGate;
	llmsOptions: LlmsCorpusOptions;
	seedResponse: FetchResult;
	seedResources: PageResources;
	seedIsLanguageSelector: boolean;
	finalSeed: string | undefined;
};

export type DiscoveryFrontier = {
	readonly truncated: boolean;
	readonly queued: number;
	take(limit: number): Promise<DiscoveredUrl[]>;
	observe(result: FetchResult, resources?: PageResources): PageResources;
	observeLinks(base: string, links: string[]): void;
};

type LinkStream = { urls: string[]; source: "crawl" | "nav"; index: number };

export function staticDiscoveryFrontier(
	urls: DiscoveredUrl[],
	truncated = false,
): DiscoveryFrontier {
	const ordered = diversityFirst(urls, (item) => item.url);
	let offset = 0;
	return {
		truncated,
		queued: 0,
		async take(limit) {
			const batch = limit > 0 ? ordered.slice(offset, offset + limit) : [];
			offset += batch.length;
			return batch;
		},
		observe(result, page = discoverFetchedResources(result)) {
			return page;
		},
		observeLinks() {},
	};
}

export function createDiscoveryFrontier(
	input: DiscoveryFrontierInput,
): DiscoveryFrontier {
	const { config } = input;
	const out: DiscoveredUrl[] = [];
	const seen = new Set(input.finalSeed ? [] : [input.inputSeed]);
	const accepted = (url: string) =>
		inScope(url, input.seed, input.scope) && input.robots.allowed(url);
	const prioritize = (urls: string[]) =>
		diversityFirst(
			config.maxExplicit
				? orderByTopic(urls, input.seed, input.scope, config.topic)
				: urls,
		);
	const seedUrls = prioritize(input.seedResources.links);
	const nav = prioritize(input.seedResources.nav ?? []);
	const streams: LinkStream[] = config.maxExplicit
		? [
				{ urls: seedUrls, source: "crawl", index: 0 },
				{ urls: nav, source: "nav", index: 0 },
			]
		: [{ urls: nav, source: "nav", index: 0 }];
	const crawl: LinkStream = { urls: [], source: "crawl", index: 0 };
	const crawlQueued = new Set<string>();
	const pagination: string[] = [];
	const paginationSeen = new Set<string>();
	const { attemptLimit } = input;
	let emitted = 0;
	let paginationIndex = 0;
	let prepared: Promise<void> | undefined;
	let truncated = Boolean(input.seedResources.truncated);

	const add = (
		raw: string | undefined,
		source: DiscoverySource,
		limit: number,
		fetched?: DiscoveredUrl["fetched"],
		metadata?: DiscoveredUrl["metadata"],
	) => {
		const url = normalizeUrl(raw ?? "");
		if (!url || out.length >= limit || seen.has(url) || !accepted(url)) return;
		addDiscovered(
			out,
			seen,
			url,
			source,
			input.seed,
			input.scope,
			fetched,
			metadata,
		);
	};

	const pump = (limit: number) => {
		for (const stream of [...streams, crawl]) {
			while (stream.index < stream.urls.length && out.length < limit) {
				const url = stream.urls[stream.index++]!;
				add(url, stream.source, limit);
			}
		}
	};

	const queue = (raw: string, base?: string) => {
		const url = normalizeUrl(raw, base);
		if (!url || seen.has(url) || crawlQueued.has(url) || !accepted(url)) {
			return;
		}
		if (crawlQueued.size >= attemptLimit) {
			truncated = true;
			return;
		}
		crawlQueued.add(url);
		crawl.urls.push(url);
	};

	const observeResult = (
		result: FetchResult,
		page: PageResources = discoverFetchedResources(result),
	) => {
		truncated ||= Boolean(page.truncated);
		if (input.seedIsLanguageSelector) return page;
		for (const url of diversityFirst(page.links)) queue(url);
		if (!isHtmlResponse(result)) return page;
		const resource = page.next;
		if (resource && !paginationSeen.has(resource) && accepted(resource)) {
			if (pagination.length >= attemptLimit) truncated = true;
			else {
				paginationSeen.add(resource);
				pagination.push(resource);
			}
		}
		return page;
	};

	const observeLinks = (base: string, links: string[]) => {
		if (input.seedIsLanguageSelector) return;
		for (const link of diversityFirst(links)) queue(link, base);
	};

	const addLlms = async (bounded: boolean) => {
		const urls = await discoverLlmsUrls(
			input.seed,
			config,
			input.llmsOptions,
			candidateWindow(config, attemptLimit),
		);
		const limit = bounded ? attemptLimit : maxGeneratedCapturePages;
		for (const url of diversityFirst(
			orderByTopic(urls, input.seed, input.scope, config.topic),
		)) {
			add(url, "llms", limit);
		}
	};

	const prepare = async () => {
		if (!config.maxExplicit) {
			const before = out.length;
			await addLlms(false);
			if (out.length > before) return;
		}
		pump(attemptLimit);
		if (!config.maxExplicit && out.length < Math.min(attemptLimit, 3)) {
			streams.push({ urls: seedUrls, source: "crawl", index: 0 });
			pump(attemptLimit);
		}
		const sitemapRemaining = attemptLimit - out.length;
		const beforeSitemap = out.length;
		if (sitemapRemaining > 0) {
			const sitemap = await discoverSitemaps(
				input.seed,
				input.robots.sitemaps,
				config,
				{
					limit: sitemapRemaining,
					scope: input.scope,
					accept: (url) => !seen.has(url) && accepted(url),
					allowResource: input.allowResource,
				},
			);
			truncated ||= sitemap.truncated;
			for (const url of diversityFirst(sitemap.urls)) {
				add(url, "sitemap", attemptLimit);
			}
		}
		const sitemapAdded = out.length - beforeSitemap;
		const richSitemap =
			sitemapRemaining > 0 && sitemapAdded >= Math.min(sitemapRemaining, 5);
		if (!richSitemap && out.length < Math.min(attemptLimit, 3)) {
			const feeds = input.seedResources.feeds ?? [];
			truncated ||= feeds.length > 2;
			for (const feedUrl of feeds.slice(0, 2)) {
				const feed = await discoverFeed(
					feedUrl,
					input.seed,
					input.scope,
					config,
					{
						limit: attemptLimit - out.length,
						accept: accepted,
						allowResource: input.allowResource,
					},
				);
				truncated ||= feed.truncated;
				for (const page of diversityFirst(feed.pages, (item) => item.url)) {
					add(page.url, "feed", attemptLimit, page.fetched, page.metadata);
				}
				if (out.length >= attemptLimit) break;
			}
		}
		if (config.maxExplicit && out.length < attemptLimit) await addLlms(true);
		if (!config.maxExplicit && streams.length === 1) {
			streams.push({ urls: seedUrls, source: "crawl", index: 0 });
		}
	};

	if (input.finalSeed) {
		addDiscovered(
			out,
			seen,
			input.seed,
			"seed",
			input.seed,
			input.scope,
			input.seedResponse,
		);
	} else {
		const response = input.seedResponse;
		out.push({
			url: input.inputSeed,
			source: "seed",
			wasSeed: true,
			fetched: filteredNonPageResult(response),
		});
	}

	observeResult(input.seedResponse, input.seedResources);
	return {
		get truncated() {
			return truncated || Boolean(input.llmsOptions.truncated);
		},
		get queued() {
			return crawlQueued.size + paginationSeen.size;
		},
		async take(limit) {
			if (limit <= 0) return [];
			const ready = out.slice(emitted, emitted + limit);
			if (ready.length > 0) {
				emitted += ready.length;
				return ready;
			}
			prepared ??= prepare();
			await prepared;
			const target = Math.min(attemptLimit, emitted + limit);
			pump(target);
			while (out.length < target && paginationIndex < pagination.length) {
				const resource = pagination[paginationIndex++]!;
				if (!(await input.allowResource(resource))) continue;
				const result = await fetchText(
					resource,
					config,
					undefined,
					undefined,
					input.allowResource,
				);
				observeResult(result);
				pump(target);
			}
			const batch = out.slice(emitted, emitted + limit);
			emitted += batch.length;
			return batch;
		},
		observe: observeResult,
		observeLinks,
	};
}

function diversityFirst<T>(items: T[], urlOf: (item: T) => string = String) {
	const paths = new Set<string>();
	const first: T[] = [];
	const variants: T[] = [];
	for (const item of items) {
		const url = new URL(urlOf(item));
		const path = `${url.origin}${url.pathname}`;
		const target = paths.has(path) ? variants : first;
		paths.add(path);
		target.push(item);
	}
	return [...first, ...variants];
}
