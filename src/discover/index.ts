import type { Config, DiscoveredUrl, FetchResult } from "../core/types.ts";
import { fetchText } from "../fetch/fetcher.ts";
import { discoverAssetPages, looksLikeAppShell } from "./assets.ts";
import {
	discoverLlmsCorpus,
	discoverLlmsUrls,
	type LlmsCorpusOptions,
	robotsForOrigin,
} from "./corpus.ts";
import { crawlScoped } from "./crawl.ts";
import {
	discoverFeed,
	discoverFeedLinks,
	discoverRelNextPages,
	isFeedResponse,
} from "./feed.ts";
import { discoverNav, discoverPageLinks } from "./nav.ts";
import { loadRobots } from "./robots.ts";
import { discoverSitemaps } from "./sitemap.ts";
import {
	addDiscovered,
	inScope,
	looksLikeFeedResourceUrl,
	normalizeDiscoveryResourceUrl,
	normalizeUrl,
	pathInScope,
	scopeFromSeed,
} from "./url.ts";

export async function discover(config: Config): Promise<DiscoveredUrl[]> {
	const inputSeed = seedInputUrl(config.seedUrl);
	if (config.pageOnly) return [{ url: inputSeed, source: "seed" }];
	const inputUrl = new URL(inputSeed);
	const seedRobots = await loadRobots(inputUrl.origin, config);
	const robotsByOrigin: LlmsCorpusOptions["robotsByOrigin"] = new Map([
		[inputUrl.origin, seedRobots],
	]);
	const llmsOptions: LlmsCorpusOptions = { cache: new Map(), robotsByOrigin };
	if (!seedRobots.allowed(inputSeed)) {
		return [
			{ url: inputSeed, source: "seed", fetched: robotsBlockedUrl(inputSeed) },
		];
	}
	if (inputUrl.pathname.endsWith("/llms.txt")) {
		return discoverLlmsCorpus(inputSeed, inputSeed, "/", config, {
			...llmsOptions,
			retryHttp: true,
		});
	}

	const inputScope = scopeFromSeed(inputSeed);
	const llmsOut = await discoverLlmsCorpus(
		inputSeed,
		inputSeed,
		inputScope,
		config,
		llmsOptions,
	);
	if (
		inputScope !== "/" &&
		llmsOut.length <= Math.min(config.max, 3) &&
		substantivePages(llmsOut) < 2
	) {
		const root = `${inputUrl.origin}/`;
		const rootLlmsOut = await discoverLlmsCorpus(
			root,
			root,
			"/",
			config,
			llmsOptions,
		);
		if (rootLlmsOut.length > llmsOut.length) return rootLlmsOut;
	}
	if (inputScope === "/" ? llmsOut.length > 0 : hasCorpus(llmsOut, config))
		return llmsOut;
	const seedResponse = await fetchText(inputSeed, config);
	if (!seedResponse.ok) {
		return [{ url: inputSeed, source: "seed", fetched: seedResponse }];
	}
	if (isFeedResponse(seedResponse)) {
		const feedSeed =
			normalizeDiscoveryResourceUrl(seedResponse.finalUrl) ?? inputSeed;
		const robots = await robotsForOrigin(
			new URL(feedSeed).origin,
			config,
			robotsByOrigin,
		);
		const allowed = (url: string) => config.ignoreRobots || robots.allowed(url);
		if (!allowed(feedSeed)) {
			return [
				{ url: feedSeed, source: "seed", fetched: robotsBlocked(seedResponse) },
			];
		}
		return discoverFeed(feedSeed, feedSeed, scopeFromSeed(feedSeed), config, {
			limit: config.max,
			response: seedResponse,
			accept: allowed,
			allowResource: allowed,
		});
	}
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
	const allowed = (url: string) => config.ignoreRobots || robots.allowed(url);
	if (!allowed(seed)) {
		return [
			{ url: seed, source: "seed", fetched: robotsBlocked(seedResponse) },
		];
	}
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
	if (usesRootFallback(seed, inputSeed)) {
		const rootLlmsOut = await discoverLlmsCorpus(
			seed,
			seed,
			"/",
			config,
			llmsOptions,
		);
		if (rootLlmsOut.length > llmsOut.length) return rootLlmsOut;
	}
	const out: DiscoveredUrl[] = [];
	const seen = new Set<string>(finalSeed ? [] : [inputSeed]);
	let limitToMax = config.maxExplicit;
	let seedIsShell = false;

	const add = (
		raw: string | undefined,
		source: DiscoveredUrl["source"],
		fetched?: DiscoveredUrl["fetched"],
		metadata?: DiscoveredUrl["metadata"],
	) => {
		if (limitToMax && out.length >= config.max) return false;
		const url = normalizeUrl(raw ?? "");
		if (!url || !allowed(url)) return false;
		const before = out.length;
		addDiscovered(out, seen, url, source, seed, scope, fetched, metadata);
		return out.length > before;
	};

	seedIsShell = seedIsLanguageSelector || looksLikeAppShell(seedResponse.body);
	if (!seedIsShell && finalSeed) add(seed, "seed", seedResponse);
	if (!config.maxExplicit) {
		const beforeLlms = out.length;
		await addLlms(seed, config, add, llmsOptions);
		if (out.length > beforeLlms) return out;
	}

	limitToMax = true;
	if (seedResponse.ok) {
		for (const url of discoverNav(seedResponse.body, seedResponse.finalUrl)) {
			if (seedIsShell && normalizeUrl(url) === seed) continue;
			add(url, "nav");
			if (out.length >= config.max) break;
		}
		if (out.length < Math.min(config.max, 3)) {
			for (const url of seedLinks) {
				if (seedIsShell && normalizeUrl(url) === seed) continue;
				add(url, "crawl");
				if (out.length >= config.max) break;
			}
		}
	}

	const beforeSitemap = out.length;
	const sitemapRemaining = config.max - out.length;
	const sitemapUrls = await discoverSitemaps(seed, robots.sitemaps, config, {
		limit: config.max - out.length,
		scope,
		accept: (url) =>
			!seen.has(url) && inScope(url, seed, scope) && allowed(url),
	});
	for (const url of sitemapUrls) {
		add(url, "sitemap");
	}
	const sitemapAdded = out.length - beforeSitemap;
	const richSitemap =
		sitemapRemaining > 0 &&
		(sitemapAdded >= sitemapRemaining ||
			sitemapAdded >= Math.min(sitemapRemaining, 5));

	if (!richSitemap && out.length < Math.min(config.max, 3)) {
		for (const feedUrl of feedLinks.slice(0, 2)) {
			const feedOrigin = new URL(feedUrl).origin;
			const feedRobots = await robotsForOrigin(
				feedOrigin,
				config,
				robotsByOrigin,
			);
			const feedAllowed = (url: string) =>
				config.ignoreRobots || feedRobots.allowed(url);
			if (!feedAllowed(feedUrl)) continue;
			const feedPages = await discoverFeed(feedUrl, seed, scope, config, {
				limit: config.max - out.length,
				accept: (url) => inScope(url, seed, scope) && allowed(url),
				allowResource: feedAllowed,
			});
			for (const page of feedPages) {
				add(page.url, "feed", page.fetched, page.metadata);
			}
			if (out.length >= config.max) break;
		}
	}

	if (config.maxExplicit && out.length < config.max) {
		await addLlms(seed, config, add, llmsOptions);
	}

	if (out.length < Math.min(config.max, 3)) {
		for (const page of await discoverRelNextPages(
			seedResponse.body,
			seedResponse.finalUrl,
			seed,
			scope,
			config,
			{
				limit: config.max - out.length,
				accept: (url) => inScope(url, seed, scope) && allowed(url),
				allowResource: allowed,
			},
		)) {
			add(page.url, page.source, page.fetched, page.metadata);
		}
	}

	if (!seedIsLanguageSelector && out.length < config.max) {
		for (const page of await crawlScoped(
			seed,
			scope,
			config.max - out.length,
			robots,
			config,
			seedResponse,
		)) {
			add(page.url, "crawl", page.fetched);
		}
	}

	if (out.length <= 1 && seedResponse.ok) {
		const assetPages = await discoverAssetPages(
			seed,
			seedResponse.body,
			config,
			{
				limit: config.max,
				scope,
				accept: (url) =>
					!seen.has(url) && inScope(url, seed, scope) && allowed(url),
			},
		);
		if (assetPages.length > 0) return assetPages;
	}
	if (out.length === 0) {
		if (!finalSeed) {
			return [
				{ url: inputSeed, source: "seed", fetched: nonPage(seedResponse) },
			];
		}
		add(seed, "seed", seedResponse);
	}

	return out;
}

function seedInputUrl(raw: string) {
	if (looksLikeFeedResourceUrl(raw)) {
		return normalizeDiscoveryResourceUrl(raw) ?? raw;
	}
	return normalizeUrl(raw) ?? normalizeDiscoveryResourceUrl(raw) ?? raw;
}

function nonPage(result: FetchResult): FetchResult {
	return {
		url: result.url,
		finalUrl: result.finalUrl,
		redirects: result.redirects ?? [],
		status: result.status,
		contentType: result.contentType,
		body: result.body,
		fetchMs: result.fetchMs,
		ok: false,
		error: "redirected to a filtered non-page URL",
		failureKind: "blocked",
	};
}

function hasCorpus(out: DiscoveredUrl[], config: Config) {
	return out.length >= Math.min(config.max, config.maxExplicit ? 3 : 2);
}

function substantivePages(out: DiscoveredUrl[]) {
	return out.filter((item) => {
		const path = new URL(item.url).pathname;
		return !/(^|\/)llms(?:-[^/]+)?\.(?:md|txt)$/i.test(path);
	}).length;
}

function usesRootFallback(seed: string, inputSeed: string) {
	const url = new URL(seed);
	const input = new URL(inputSeed);
	return (
		!url.pathname.endsWith("/") &&
		input.pathname.split("/").filter(Boolean).length === 1
	);
}

async function addLlms(
	seed: string,
	config: Config,
	add: (raw: string | undefined, source: "llms") => boolean,
	options: LlmsCorpusOptions,
) {
	for (const url of await discoverLlmsUrls(seed, config, options)) {
		add(url, "llms");
	}
}

function chooseScope(inputScope: string, seed: string, links: string[]) {
	if (inputScope === "/" || !pathInScope(new URL(seed).pathname, inputScope))
		return scopeFromSeed(seed);
	let best = inputScope;
	let bestCount = countInScope(links, seed, best);
	for (const scope of parentScopes(inputScope)) {
		if (scope === "/" && bestCount >= 3) continue;
		const count = countInScope(links, seed, scope);
		if (count > bestCount + 2) {
			best = scope;
			bestCount = count;
		}
	}
	return best;
}

function countInScope(links: string[], seed: string, scope: string) {
	return links.filter((link) => inScope(link, seed, scope)).length;
}

function parentScopes(scope: string) {
	const parts = scope.split("/").filter(Boolean);
	const scopes: string[] = [];
	for (let i = parts.length - 1; i >= 1; i--) {
		scopes.push(`/${parts.slice(0, i).join("/")}/`);
	}
	scopes.push("/");
	return scopes;
}

function robotsBlocked(response: FetchResult): FetchResult {
	return {
		url: response.url,
		finalUrl: response.finalUrl,
		redirects: response.redirects ?? [],
		status: response.status,
		contentType: response.contentType,
		body: "",
		fetchMs: response.fetchMs,
		ok: false,
		error: "blocked by robots.txt",
		failureKind: "blocked",
	};
}

function robotsBlockedUrl(url: string): FetchResult {
	return {
		url,
		finalUrl: url,
		redirects: [],
		status: 0,
		contentType: "",
		body: "",
		fetchMs: 0,
		ok: false,
		error: "blocked by robots.txt",
		failureKind: "blocked",
	};
}

function isLanguageSelector(finalUrl: string, html: string) {
	return (
		/\/select-language(?:[/?#]|$)/i.test(finalUrl) &&
		/path-select-language|ecl-splash-page__language|currentPath":"select-language/i.test(
			html,
		)
	);
}
