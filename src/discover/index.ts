import type {
	ConditionalRequest,
	DiscoveredUrl,
	DiscoveryResourceSeed,
	FetchResult,
	PipelineConfig,
} from "../core/types.ts";
import {
	classifyDiscoveryResource,
	isLlmsResourcePath,
	looksLikeSpecificContentUrl,
	scopeFromFeedResource,
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
import { discoverFeed, isFeedResponse } from "./feed.ts";
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

	const seedIsLlms = classifyDiscoveryResource(inputSeed)?.source === "llms";
	if (seedIsLlms) {
		llmsOptions.cache?.set(
			inputSeed,
			fetchText(inputSeed, config, preferredMarkdownAccept),
		);
	}
	const overlapSeed =
		!seedIsLlms && config.concurrency > 1 && config.perOrigin > 1;
	const seedResponsePromise = overlapSeed
		? fetchText(inputSeed, config)
		: undefined;
	const corpus = await resolveLlmsCorpus(
		config,
		inputSeed,
		overlapSeed
			? {
					...llmsOptions,
					initialFetchLimit: Math.min(config.concurrency, config.perOrigin) - 1,
				}
			: llmsOptions,
		attemptLimit,
	);
	if ("done" in corpus && seedIsLlms) {
		const done = corpus.done.map((item) =>
			item.url === inputSeed ? { ...item, wasSeed: true as const } : item,
		);
		if (done.length === 0) {
			const response = await llmsOptions.cache?.get(inputSeed);
			return {
				urls: [await explicitLlmsSeedFailure(config, inputSeed, response)],
				truncated: Boolean(llmsOptions.truncated),
			};
		}
		const response = await llmsOptions.cache?.get(inputSeed);
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

	const seedResponse = await (seedResponsePromise ??
		fetchText(inputSeed, config));
	if ("done" in corpus) {
		return {
			urls: seedFirstCorpus(
				seedEntry(
					normalizeUrl(seedResponse.finalUrl) ?? inputSeed,
					"seed",
					seedResponse,
				),
				corpus.done,
				config,
				attemptLimit,
			),
			truncated: Boolean(llmsOptions.truncated),
		};
	}
	if (!seedResponse.ok) {
		return { urls: [seedEntry(inputSeed, "seed", seedResponse)] };
	}

	if (isFeedResponse(seedResponse)) {
		const feedSeed =
			normalizeDiscoveryResourceUrl(seedResponse.finalUrl) ?? inputSeed;
		const seedResource: DiscoveryResourceSeed = {
			url: inputSeed,
			finalUrl: feedSeed,
			source: "feed",
		};
		const robots = await loadRobots(new URL(feedSeed).origin, config);
		const feed = await discoverFeed(
			feedSeed,
			feedSeed,
			scopeFromFeedResource(feedSeed),
			config,
			{
				limit: attemptLimit,
				response: seedResponse,
				accept: robots.allowed,
			},
		);
		if (feed.pages.length > 0) {
			return { urls: feed.pages, seedResource, truncated: feed.truncated };
		}
		return {
			urls: [
				seedEntry(
					feedSeed,
					"feed",
					emptyResourceResult(
						seedResponse,
						"feed resource did not list any in-scope pages",
					),
				),
			],
			seedResource,
		};
	}

	const resolved = await resolveHtmlSeed(
		config,
		inputSeed,
		seedResponse,
		corpus.llmsOut,
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

async function resolveLlmsCorpus(
	config: PipelineConfig,
	inputSeed: string,
	llmsOptions: LlmsCorpusOptions,
	attemptLimit: number,
): Promise<IndexHit | { llmsOut: DiscoveredUrl[] }> {
	const inputUrl = new URL(inputSeed);
	if (classifyDiscoveryResource(inputSeed)?.source === "llms") {
		return {
			done: await discoverLlmsCorpus(
				inputSeed,
				inputSeed,
				"/",
				config,
				llmsOptions,
				attemptLimit,
			),
		};
	}
	if (deferInitialLlms(config, inputSeed)) return { llmsOut: [] };

	const inputScope = scopeFromSeed(inputSeed);
	let llmsOut = await discoverLlmsCorpus(
		inputSeed,
		inputSeed,
		inputScope,
		config,
		llmsOptions,
		attemptLimit,
	);
	const substantivePageCount = llmsOut.filter((item) => {
		const path = new URL(item.url).pathname;
		return !isLlmsResourcePath(path);
	}).length;
	if (
		inputScope !== "/" &&
		llmsOut.length <= Math.min(config.max, 3) &&
		substantivePageCount < 2
	) {
		const rootLlmsOut = await discoverLlmsCorpus(
			`${inputUrl.origin}/`,
			inputSeed,
			inputScope,
			config,
			llmsOptions,
			attemptLimit,
		);
		if (rootLlmsOut.length > llmsOut.length) llmsOut = rootLlmsOut;
	}
	if (llmsIsCorpus(llmsOut, config, inputScope)) return { done: llmsOut };
	return { llmsOut };
}

async function resolveHtmlSeed(
	config: PipelineConfig,
	inputSeed: string,
	seedResponse: FetchResult,
	llmsOut: DiscoveredUrl[],
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

	if (!deferInitialLlms(config, inputSeed)) {
		const redirected = await redirectedLlmsCorpus(
			config,
			inputSeed,
			seed,
			inputScope,
			scope,
			llmsOut,
			llmsOptions,
			attemptLimit,
		);
		if (redirected) {
			return {
				done: seedFirstCorpus(seedPage, redirected, config, attemptLimit),
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
		llmsOptions,
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

async function redirectedLlmsCorpus(
	config: PipelineConfig,
	inputSeed: string,
	seed: string,
	inputScope: string,
	scope: string,
	llmsOut: DiscoveredUrl[],
	llmsOptions: LlmsCorpusOptions,
	attemptLimit: number,
): Promise<DiscoveredUrl[] | undefined> {
	if (seed !== inputSeed || scope !== inputScope) {
		const adjusted = await discoverLlmsCorpus(
			seed,
			seed,
			scope,
			config,
			llmsOptions,
			attemptLimit,
		);
		if (llmsIsCorpus(adjusted, config, scope)) return adjusted;
	}
	const seedUrl = new URL(seed);
	const inputUrl = new URL(inputSeed);
	if (
		seedUrl.pathname.endsWith("/") ||
		inputUrl.pathname.split("/").filter(Boolean).length !== 1
	) {
		return;
	}
	const sameOrigin = seedUrl.origin === inputUrl.origin;
	const root = await discoverLlmsCorpus(
		seed,
		sameOrigin ? inputSeed : seed,
		sameOrigin ? inputScope : "/",
		config,
		llmsOptions,
		attemptLimit,
	);
	if (
		root.length > llmsOut.length &&
		llmsIsCorpus(root, config, sameOrigin ? inputScope : "/")
	) {
		return root;
	}
	return undefined;
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
		accept: (url) => robots.allowed(url),
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

function llmsIsCorpus(
	out: DiscoveredUrl[],
	config: PipelineConfig,
	scope: string,
) {
	return scope === "/" ? out.length > 0 : hasCorpus(out, config);
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
