import type {
	ConditionalRequest,
	DiscoveredUrl,
	DiscoveryResourceSeed,
	FetchResult,
	PipelineConfig,
} from "../core/types.ts";
import {
	classifyDiscoveryResource,
	looksLikeSpecificContentUrl,
} from "../core/url.ts";
import { isLanguageSelector } from "../extract/app-shell.ts";
import {
	type FetchUrlGate,
	fetchText,
	preferredMarkdownAccept,
} from "../fetch/fetcher.ts";
import { emptyResourceResult } from "../fetch/result.ts";
import {
	discoverLlmsCorpus,
	type LlmsCorpusOptions,
	resourceAllowed,
} from "./corpus.ts";
import {
	createDiscoveryFrontier,
	type DiscoveryFrontier,
	type DiscoveryFrontierInput,
	staticDiscoveryFrontier,
} from "./frontier.ts";
import { discoverPageResources } from "./nav.ts";
import { loadRobots, type Robots } from "./robots.ts";
import { pageOnlyDiscovery, seedFirstCorpus, seedInputUrl } from "./seed.ts";
import { discoverSitemaps } from "./sitemap.ts";
import { candidateWindow, orderByTopic } from "./topic.ts";
import {
	addDiscovered,
	chooseScope,
	normalizeDiscoveryResourceUrl,
	normalizeUrl,
	pathAllowed,
	scopeFromSeed,
} from "./url.ts";

type DiscoveryRun = {
	urls: DiscoveredUrl[];
	seedResource?: DiscoveryResourceSeed;
	complete?: boolean;
	truncated?: boolean;
};

export type DiscoverySession = {
	frontier: DiscoveryFrontier;
	allowResource?: FetchUrlGate;
	seedResource?: DiscoveryResourceSeed;
};

type RawDiscovery = DiscoveryRun | DiscoverySession;

export async function startDiscovery(
	config: PipelineConfig,
	pageConditional?: ConditionalRequest,
	attemptLimit = config.max,
): Promise<DiscoverySession> {
	const raw = await discoverRawRun(config, pageConditional, attemptLimit);
	if ("frontier" in raw) return raw;
	const session: DiscoverySession = {
		frontier: staticDiscoveryFrontier(
			raw.urls,
			Boolean(raw.truncated) || raw.complete === false,
		),
	};
	if (raw.seedResource) session.seedResource = raw.seedResource;
	return session;
}

async function discoverRawRun(
	config: PipelineConfig,
	pageConditional?: ConditionalRequest,
	attemptLimit = config.max,
): Promise<RawDiscovery> {
	const inputSeed = seedInputUrl(config.seedUrl);
	const seedRobots = await loadRobots(new URL(inputSeed).origin, config);

	if (config.pageOnly) {
		return {
			urls: await pageOnlyDiscovery(
				config,
				inputSeed,
				seedRobots,
				pageConditional,
			),
		};
	}

	const llmsOptions: LlmsCorpusOptions = { cache: new Map() };

	if (classifyDiscoveryResource(inputSeed)?.source === "llms") {
		llmsOptions.cache?.set(
			inputSeed,
			fetchText(inputSeed, config, preferredMarkdownAccept),
		);
		const listed = await discoverLlmsCorpus(
			inputSeed,
			inputSeed,
			"/",
			config,
			llmsOptions,
			attemptLimit,
		);
		const done = listed.map((item) =>
			item.url === inputSeed ? { ...item, wasSeed: true as const } : item,
		);
		const response = await llmsOptions.cache?.get(inputSeed);
		if (done.length === 0) {
			return {
				urls: [await explicitLlmsSeedFailure(config, inputSeed, response)],
				truncated: Boolean(llmsOptions.truncated),
			};
		}
		const seedResource: DiscoveryResourceSeed = {
			url: inputSeed,
			finalUrl:
				(response && normalizeDiscoveryResourceUrl(response.finalUrl)) ??
				inputSeed,
			source: "llms",
		};
		return {
			urls: done,
			seedResource,
			truncated: Boolean(llmsOptions.truncated),
		};
	}

	const seedResponse = await fetchText(inputSeed, config);
	if (!seedResponse.ok) {
		return { urls: [seedEntry(inputSeed, "seed", seedResponse)] };
	}

	const resolved = await resolveHtmlSeed(
		config,
		inputSeed,
		seedResponse,
		llmsOptions,
		attemptLimit,
	);
	if ("done" in resolved) {
		return {
			urls: resolved.done,
			truncated: Boolean(llmsOptions.truncated) || Boolean(resolved.truncated),
		};
	}
	return resolved;
}

async function explicitLlmsSeedFailure(
	config: PipelineConfig,
	inputSeed: string,
	seedResponse?: FetchResult,
): Promise<DiscoveredUrl> {
	const response =
		seedResponse ??
		(await fetchText(inputSeed, config, preferredMarkdownAccept));
	return seedEntry(
		inputSeed,
		"llms",
		response.ok
			? emptyResourceResult(
					response,
					"llms resource did not list any in-scope pages",
				)
			: response,
	);
}

type IndexHit = { done: DiscoveredUrl[]; truncated?: boolean };

async function resolveHtmlSeed(
	config: PipelineConfig,
	inputSeed: string,
	seedResponse: FetchResult,
	llmsOptions: LlmsCorpusOptions,
	attemptLimit: number,
): Promise<IndexHit | DiscoverySession> {
	const inputScope = scopeFromSeed(inputSeed);
	const finalSeed = normalizeUrl(seedResponse.finalUrl);
	const seed = finalSeed ?? inputSeed;
	const seedResources = discoverPageResources(
		seedResponse.body,
		seedResponse.finalUrl,
		true,
	);
	const seedIsLanguageSelector = isLanguageSelector(
		seedResponse.finalUrl,
		seedResponse.body,
	);
	const scope = seedIsLanguageSelector
		? "/"
		: chooseScope(inputScope, seed, seedResources.links);
	const robots = await loadRobots(new URL(seed).origin, config);
	const allowResource: FetchUrlGate = (url) => resourceAllowed(url, config);
	const seedPage = seedEntry(seed, "seed", seedResponse);

	let llmsOut: DiscoveredUrl[] = [];
	if (!deferInitialLlms(config, inputSeed)) {
		llmsOut = await discoverLlmsCorpus(
			seed,
			seed,
			scope,
			config,
			llmsOptions,
			attemptLimit,
		);
		if (llmsIsCorpus(llmsOut, config)) {
			return {
				done: seedFirstCorpus(seedPage, llmsOut, config, attemptLimit),
			};
		}
	}

	const sitemap = await discoverSitemapIndex(
		seed,
		scope,
		robots,
		config,
		attemptLimit,
		allowResource,
	);
	if (hasCorpus(sitemap.pages, config)) {
		return {
			done: seedFirstCorpus(seedPage, sitemap.pages, config, attemptLimit),
			truncated: sitemap.truncated,
		};
	}

	const context: DiscoveryFrontierInput = {
		config,
		attemptLimit,
		seed,
		scope,
		robots,
		allowResource,
		indexTruncated: Boolean(llmsOptions.truncated),
		seedResponse,
		seedResources,
		seedIsLanguageSelector,
		finalSeed,
		inputSeed,
		indexUrls: [...llmsOut, ...sitemap.pages],
	};
	return {
		frontier: createDiscoveryFrontier(context),
		allowResource,
	};
}

async function discoverSitemapIndex(
	seed: string,
	scope: string,
	robots: Robots,
	config: PipelineConfig,
	attemptLimit: number,
	allowResource: FetchUrlGate,
): Promise<{ pages: DiscoveredUrl[]; truncated: boolean }> {
	const sitemap = await discoverSitemaps(seed, robots.sitemaps, config, {
		limit: candidateWindow(config, attemptLimit),
		scope,
		accept: (url) => robots.allowed(url) && pathAllowed(url, config),
		allowResource,
	});
	const ranked = config.maxExplicit
		? orderByTopic(sitemap.urls, seed, scope)
		: sitemap.urls;
	const pages: DiscoveredUrl[] = [];
	const seen = new Set<string>();
	for (const url of ranked) {
		addDiscovered(pages, seen, url, "sitemap", seed, scope);
		if (config.maxExplicit && pages.length >= attemptLimit) break;
	}
	return { pages, truncated: sitemap.truncated };
}

function llmsIsCorpus(out: DiscoveredUrl[], config: PipelineConfig) {
	return out.length >= Math.min(config.max, 3);
}

function hasCorpus(out: DiscoveredUrl[], config: PipelineConfig) {
	return out.length >= Math.min(config.max, config.maxExplicit ? 3 : 2);
}

function deferInitialLlms(config: PipelineConfig, seed: string) {
	return config.maxExplicit && looksLikeSpecificContentUrl(seed);
}

function seedEntry(
	url: string,
	source: DiscoveredUrl["source"],
	fetched: FetchResult,
): DiscoveredUrl {
	return { url, source, wasSeed: true, fetched };
}
