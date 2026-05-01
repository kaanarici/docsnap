import type { Config, DiscoveredUrl, FetchResult } from "../core/types.ts";
import { fetchText } from "../fetch/fetcher.ts";
import { discoverAssetPages, looksLikeAppShell } from "./assets.ts";
import { crawlScoped } from "./crawl.ts";
import { discoverLlms, type LlmsDiscoveryOptions } from "./llms.ts";
import { discoverNav, discoverPageLinks } from "./nav.ts";
import { loadRobots } from "./robots.ts";
import { discoverSitemaps } from "./sitemap.ts";
import {
	addDiscovered,
	inScope,
	normalizeUrl,
	pathInScope,
	scopeFromSeed,
} from "./url.ts";

export async function discover(config: Config): Promise<DiscoveredUrl[]> {
	const inputSeed = normalizeUrl(config.seedUrl) ?? config.seedUrl;
	const llmsOptions: LlmsDiscoveryOptions = { cache: new Map() };
	if (config.pageOnly) return [{ url: inputSeed, source: "seed" }];
	const inputUrl = new URL(inputSeed);
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
	const finalSeed = normalizeUrl(seedResponse.finalUrl);
	const seed = finalSeed ?? inputSeed;
	const seedLinks = discoverPageLinks(seedResponse.body, seedResponse.finalUrl);
	const seedIsLanguageSelector = isLanguageSelector(
		seedResponse.finalUrl,
		seedResponse.body,
	);
	const scope = seedIsLanguageSelector
		? "/"
		: chooseScope(inputScope, seed, seedLinks);
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
	const robots = await loadRobots(new URL(seed).origin, config);
	const out: DiscoveredUrl[] = [];
	const seen = new Set<string>(finalSeed ? [] : [inputSeed]);
	let limitToMax = config.maxExplicit;
	let seedIsShell = false;

	const allowed = (url: string) => config.ignoreRobots || robots.allowed(url);
	if (!allowed(seed)) {
		return [
			{ url: seed, source: "seed", fetched: robotsBlocked(seedResponse) },
		];
	}
	const add = (
		raw: string | undefined,
		source: DiscoveredUrl["source"],
		fetched?: DiscoveredUrl["fetched"],
	) => {
		if (limitToMax && out.length >= config.max) return false;
		const url = normalizeUrl(raw ?? "");
		if (!url || !allowed(url)) return false;
		const before = out.length;
		addDiscovered(out, seen, url, source, seed, scope, fetched);
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

	const sitemapUrls = await discoverSitemaps(seed, robots.sitemaps, config, {
		limit: config.max - out.length,
		scope,
		accept: (url) =>
			!seen.has(url) && inScope(url, seed, scope) && allowed(url),
	});
	for (const url of sitemapUrls) {
		add(url, "sitemap");
	}

	if (config.maxExplicit && out.length < config.max) {
		await addLlms(seed, config, add, llmsOptions);
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

function nonPage(result: FetchResult): FetchResult {
	return {
		url: result.url,
		finalUrl: result.finalUrl,
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
	options: LlmsDiscoveryOptions,
) {
	for (const url of await discoverLlms(seed, config, options)) {
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
		status: response.status,
		contentType: response.contentType,
		body: "",
		fetchMs: response.fetchMs,
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

async function discoverLlmsCorpus(
	seed: string,
	sourceSeed: string,
	scope: string,
	config: Config,
	options: LlmsDiscoveryOptions,
) {
	const llmsUrls = await discoverLlms(seed, config, options);
	const corpus = corpusTarget(seed, llmsUrls);
	const includeRootLlms =
		!corpus && hasScopedSameOriginLinks(llmsUrls, sourceSeed, scope);
	const robotsByOrigin = new Map<
		string,
		Awaited<ReturnType<typeof loadRobots>>
	>();
	const out: DiscoveredUrl[] = [];
	const seen = new Set<string>();
	const sourceOrigin = new URL(sourceSeed).origin;
	for (const raw of llmsUrls) {
		const url = normalizeUrl(raw);
		if (!url || !inCorpus(url, sourceSeed, scope, corpus)) continue;
		const parsed = new URL(url);
		const origin = parsed.origin;
		let robots = robotsByOrigin.get(origin);
		if (!robots) {
			robots = await loadRobots(origin, config);
			robotsByOrigin.set(origin, robots);
		}
		if (!config.ignoreRobots && !robots.allowed(url)) continue;
		const rootLlms =
			includeRootLlms &&
			origin === sourceOrigin &&
			parsed.pathname === "/llms.txt";
		addDiscovered(
			out,
			seen,
			url,
			"llms",
			rootLlms
				? `${origin}/`
				: corpus && new URL(url).origin === corpus.origin
					? `${corpus.origin}${corpus.scope}`
					: sourceSeed,
			rootLlms
				? "/"
				: corpus && new URL(url).origin === corpus.origin
					? corpus.scope
					: scope,
		);
		if (config.maxExplicit && out.length >= config.max) break;
	}
	return out;
}

function hasScopedSameOriginLinks(
	urls: string[],
	sourceSeed: string,
	scope: string,
) {
	const source = new URL(sourceSeed);
	return urls.some((raw) => {
		const url = new URL(raw);
		return (
			url.origin === source.origin &&
			url.pathname !== "/llms.txt" &&
			pathInScope(url.pathname, scope)
		);
	});
}

function inCorpus(
	url: string,
	sourceSeed: string,
	scope: string,
	corpus: { origin: string; scope: string } | undefined,
) {
	const parsed = new URL(url);
	const source = new URL(sourceSeed);
	if (parsed.origin === source.origin)
		return (
			parsed.pathname === "/llms.txt" || pathInScope(parsed.pathname, scope)
		);
	return (
		corpus !== undefined &&
		parsed.origin === corpus.origin &&
		pathInScope(parsed.pathname, corpus.scope)
	);
}

function corpusTarget(seed: string, urls: string[]) {
	const seedUrl = new URL(seed);
	const byOrigin = new Map<string, URL[]>();
	for (const raw of urls) {
		const url = new URL(raw);
		if (url.origin === seedUrl.origin) continue;
		const group = byOrigin.get(url.origin) ?? [];
		group.push(url);
		byOrigin.set(url.origin, group);
	}
	const best = [...byOrigin.entries()].sort(
		(a, b) => b[1].length - a[1].length,
	)[0];
	const fileHeavy = best ? mostlyCorpusFiles(best[1]) : false;
	if (
		!best ||
		best[1].length < 5 ||
		(!fileHeavy && !relatedHost(seedUrl.hostname, new URL(best[0]).hostname))
	)
		return undefined;
	const scope = commonScope(best[1]);
	if (!fileHeavy && scope === "/") return undefined;
	return { origin: best[0], scope };
}

function relatedHost(left: string, right: string) {
	return (
		left === right || left.endsWith(`.${right}`) || right.endsWith(`.${left}`)
	);
}

function commonScope(urls: URL[]) {
	const paths = urls.map((url) => url.pathname.split("/").filter(Boolean));
	let length = 0;
	while (
		paths.every((path) => path[length] && path[length] === paths[0]![length])
	) {
		length++;
	}
	return length > 0 ? `/${paths[0]!.slice(0, length).join("/")}/` : "/";
}

function mostlyCorpusFiles(urls: URL[]) {
	return (
		urls.filter((url) => /\.(mdx?|txt|ya?ml|json)$/i.test(url.pathname))
			.length >=
		urls.length * 0.8
	);
}
