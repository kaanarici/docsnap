import type {
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
import { isLanguageSelector, looksLikeAppShell } from "../extract/app-shell.ts";
import { type FetchUrlGate, fetchText } from "../fetch/fetcher.ts";
import { emptyResourceResult, robotsBlockedResult } from "../fetch/result.ts";
import {
	canonicalOriginSeed,
	disallowedSeedDiscovery,
} from "./blocked-seed.ts";
import {
	discoverLlmsCorpus,
	type LlmsCorpusOptions,
	resourceAllowed,
	robotsForOrigin,
} from "./corpus.ts";
import { discoverFeed, discoverFeedLinks, isFeedResponse } from "./feed.ts";
import { discoverPageLinks } from "./nav.ts";
import { type DiscoveryProbeInput, runProbes } from "./probes.ts";
import { loadRobots, type Robots } from "./robots.ts";
import {
	pageOnlyDiscovery,
	seedFirstCorpus,
	seedFirstDiscovery,
	seedInputUrl,
} from "./seed.ts";
import {
	chooseScope,
	normalizeDiscoveryResourceUrl,
	normalizeUrl,
	scopeFromSeed,
} from "./url.ts";

export type DiscoveryRun = {
	urls: DiscoveredUrl[];
	seedResource?: DiscoveryResourceSeed;
};

export async function discoverRun(
	config: PipelineConfig,
): Promise<DiscoveryRun> {
	const run = await discoverRawRun(config);
	return { ...run, urls: seedFirstDiscovery(config, run.urls) };
}

async function discoverRawRun(config: PipelineConfig): Promise<DiscoveryRun> {
	const inputSeed = seedInputUrl(config.seedUrl);
	const inputUrl = new URL(inputSeed);
	const seedRobots = await loadRobots(inputUrl.origin, config);

	if (config.pageOnly)
		return { urls: await pageOnlyDiscovery(config, inputSeed, seedRobots) };

	const robotsByOrigin: LlmsCorpusOptions["robotsByOrigin"] = new Map([
		[inputUrl.origin, seedRobots],
	]);
	const llmsOptions: LlmsCorpusOptions = { cache: new Map(), robotsByOrigin };
	const allowResource: FetchUrlGate = (url) =>
		resourceAllowed(url, config, robotsByOrigin);

	const blocked = await resolveBlockedSeed(
		config,
		inputSeed,
		seedRobots,
		llmsOptions,
		allowResource,
	);
	if (blocked) return { urls: blocked };

	const corpus = await resolveLlmsCorpus(config, inputSeed, llmsOptions);
	if ("done" in corpus) {
		if (classifyDiscoveryResource(inputSeed)?.source === "llms") {
			const done = corpus.done.map((item) =>
				item.url === inputSeed ? { ...item, wasSeed: true as const } : item,
			);
			const response = await llmsOptions.cache?.get(inputSeed);
			const seedResource: DiscoveryResourceSeed = {
				url: inputSeed,
				finalUrl:
					(response && normalizeDiscoveryResourceUrl(response.finalUrl)) ??
					inputSeed,
				source: "llms",
			};
			return {
				urls:
					done.length > 0
						? done
						: [await explicitLlmsSeedFailure(config, inputSeed, allowResource)],
				...(done.length > 0 ? { seedResource } : {}),
			};
		}
		return { urls: corpus.done };
	}

	const seedResponse = await fetchText(
		inputSeed,
		config,
		undefined,
		undefined,
		allowResource,
	);
	if (!seedResponse.ok) {
		return {
			urls: [
				{
					url: inputSeed,
					source: "seed",
					wasSeed: true,
					fetched: seedResponse,
				},
			],
		};
	}

	const feed = await resolveFeedSeed(
		config,
		inputSeed,
		seedResponse,
		robotsByOrigin,
		allowResource,
	);
	if (feed) return feed;

	const resolved = await resolveHtmlSeed(
		config,
		inputSeed,
		seedResponse,
		corpus.llmsOut,
		llmsOptions,
		robotsByOrigin,
	);
	if ("done" in resolved) return { urls: resolved.done };

	return { urls: await runProbes(resolved.context) };
}

async function explicitLlmsSeedFailure(
	config: PipelineConfig,
	inputSeed: string,
	allowResource: FetchUrlGate | undefined,
): Promise<DiscoveredUrl> {
	const response = await fetchText(
		inputSeed,
		config,
		"text/markdown,text/plain,*/*;q=0.8",
		undefined,
		allowResource,
	);
	return {
		url: inputSeed,
		source: "llms",
		wasSeed: true,
		fetched: response.ok
			? emptyResourceResult(
					response,
					"llms resource did not list any in-scope pages",
				)
			: response,
	};
}

async function resolveBlockedSeed(
	config: PipelineConfig,
	inputSeed: string,
	seedRobots: Robots,
	llmsOptions: LlmsCorpusOptions,
	allowResource: FetchUrlGate | undefined,
): Promise<DiscoveredUrl[] | undefined> {
	if (seedRobots.allowed(inputSeed)) return undefined;
	if (seedRobots.unreachable) {
		const { moved, failure } = await canonicalOriginSeed(
			inputSeed,
			config,
			allowResource,
		);
		if (moved) return (await discoverRun({ ...config, seedUrl: moved })).urls;
		return [
			{
				url: inputSeed,
				source: "seed",
				wasSeed: true,
				fetched: failure ?? robotsBlockedResult(inputSeed),
			},
		];
	}
	return disallowedSeedDiscovery(
		inputSeed,
		seedRobots,
		config,
		llmsOptions,
		async (nextConfig) => (await discoverRun(nextConfig)).urls,
	);
}

async function resolveLlmsCorpus(
	config: PipelineConfig,
	inputSeed: string,
	llmsOptions: LlmsCorpusOptions,
): Promise<{ done: DiscoveredUrl[] } | { llmsOut: DiscoveredUrl[] }> {
	const inputUrl = new URL(inputSeed);
	if (classifyDiscoveryResource(inputSeed)?.source === "llms") {
		return {
			done: await discoverLlmsCorpus(
				inputSeed,
				inputSeed,
				"/",
				config,
				llmsOptions,
			),
		};
	}
	if (deferInitialLlms(config, inputSeed)) return { llmsOut: [] };

	const inputScope = scopeFromSeed(inputSeed);
	const llmsOut = await discoverLlmsCorpus(
		inputSeed,
		inputSeed,
		inputScope,
		config,
		llmsOptions,
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
		const root = `${inputUrl.origin}/`;
		const rootLlmsOut = await discoverLlmsCorpus(
			root,
			inputSeed,
			inputScope,
			config,
			llmsOptions,
		);
		if (rootLlmsOut.length > llmsOut.length) return { done: rootLlmsOut };
	}
	if (inputScope === "/" ? llmsOut.length > 0 : hasCorpus(llmsOut, config)) {
		return { done: llmsOut };
	}
	return { llmsOut };
}

async function resolveFeedSeed(
	config: PipelineConfig,
	inputSeed: string,
	seedResponse: FetchResult,
	robotsByOrigin: Map<string, Robots>,
	allowResource: FetchUrlGate | undefined,
): Promise<DiscoveryRun | undefined> {
	if (!isFeedResponse(seedResponse)) return undefined;
	const feedSeed =
		normalizeDiscoveryResourceUrl(seedResponse.finalUrl) ?? inputSeed;
	const seedResource: DiscoveryResourceSeed = {
		url: inputSeed,
		finalUrl: feedSeed,
		source: "feed",
	};
	const robots = await robotsForOrigin(
		new URL(feedSeed).origin,
		config,
		robotsByOrigin,
	);
	const allowed = (url: string) => robots.allowed(url);
	if (!allowed(feedSeed)) {
		return {
			urls: [
				{
					url: feedSeed,
					source: "feed",
					wasSeed: true,
					fetched: robotsBlockedResult(seedResponse),
				},
			],
			seedResource,
		};
	}
	const pages = await discoverFeed(
		feedSeed,
		feedSeed,
		scopeFromFeedResource(feedSeed),
		config,
		{
			limit: config.max,
			response: seedResponse,
			accept: allowed,
			allowResource,
		},
	);
	if (pages.length > 0) return { urls: pages, seedResource };
	return {
		urls: [
			{
				url: feedSeed,
				source: "feed",
				wasSeed: true,
				fetched: emptyResourceResult(
					seedResponse,
					"feed resource did not list any in-scope pages",
				),
			},
		],
		seedResource,
	};
}

async function resolveHtmlSeed(
	config: PipelineConfig,
	inputSeed: string,
	seedResponse: FetchResult,
	llmsOut: DiscoveredUrl[],
	llmsOptions: LlmsCorpusOptions,
	robotsByOrigin: Map<string, Robots>,
): Promise<{ done: DiscoveredUrl[] } | { context: DiscoveryProbeInput }> {
	const inputScope = scopeFromSeed(inputSeed);
	const finalSeed = normalizeUrl(seedResponse.finalUrl);
	const seed = finalSeed ?? inputSeed;
	const seedLinks = discoverPageLinks(seedResponse.body, seedResponse.finalUrl);
	const feedLinks = discoverFeedLinks(seedResponse.body, seedResponse.finalUrl);
	const seedIsLanguageSelector = isLanguageSelector(
		seedResponse.finalUrl,
		seedResponse.body,
	);
	const scope = seedIsLanguageSelector
		? "/"
		: chooseScope(inputScope, seed, seedLinks);
	const robots = await robotsForOrigin(
		new URL(seed).origin,
		config,
		robotsByOrigin,
	);
	const allowed = (url: string) => robots.allowed(url);
	if (!allowed(seed)) {
		return {
			done: [
				{
					url: seed,
					source: "seed",
					wasSeed: true,
					fetched: robotsBlockedResult(seedResponse),
				},
			],
		};
	}

	const redirected = deferInitialLlms(config, inputSeed)
		? undefined
		: await resolveRedirectAdjustedLlms(
				config,
				inputSeed,
				inputScope,
				seed,
				scope,
				llmsOut,
				llmsOptions,
			);
	if (redirected) {
		return {
			done: seedFirstCorpus(
				{ url: seed, source: "seed", wasSeed: true, fetched: seedResponse },
				redirected,
				config,
			),
		};
	}

	const seedIsShell =
		seedIsLanguageSelector || looksLikeAppShell(seedResponse.body);
	const context: DiscoveryProbeInput = {
		config,
		seed,
		scope,
		robots,
		allowed,
		allowResource: (url) => resourceAllowed(url, config, robotsByOrigin),
		llmsOptions,
		seedResponse,
		seedLinks,
		feedLinks,
		seedIsShell,
		seedIsLanguageSelector,
		finalSeed,
		inputSeed,
	};
	return { context };
}

async function resolveRedirectAdjustedLlms(
	config: PipelineConfig,
	inputSeed: string,
	inputScope: string,
	seed: string,
	scope: string,
	llmsOut: DiscoveredUrl[],
	llmsOptions: LlmsCorpusOptions,
): Promise<DiscoveredUrl[] | undefined> {
	if (seed !== inputSeed || scope !== inputScope) {
		const redirectedLlmsOut = await discoverLlmsCorpus(
			seed,
			seed,
			scope,
			config,
			llmsOptions,
		);
		if (hasCorpus(redirectedLlmsOut, config)) return redirectedLlmsOut;
	}
	const seedUrl = new URL(seed);
	const inputUrl = new URL(inputSeed);
	if (
		!seedUrl.pathname.endsWith("/") &&
		inputUrl.pathname.split("/").filter(Boolean).length === 1
	) {
		const sameOrigin = seedUrl.origin === inputUrl.origin;
		const rootLlmsOut = await discoverLlmsCorpus(
			seed,
			sameOrigin ? inputSeed : seed,
			sameOrigin ? inputScope : "/",
			config,
			llmsOptions,
		);
		if (rootLlmsOut.length > llmsOut.length) return rootLlmsOut;
	}
	return undefined;
}

function hasCorpus(out: DiscoveredUrl[], config: PipelineConfig) {
	return out.length >= Math.min(config.max, config.maxExplicit ? 3 : 2);
}

function deferInitialLlms(config: PipelineConfig, seed: string) {
	return config.maxExplicit && looksLikeSpecificContentUrl(seed);
}
