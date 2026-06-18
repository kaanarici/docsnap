import type {
	DiscoveredUrl,
	DiscoverySource,
	FetchResult,
	PipelineConfig,
} from "../core/types.ts";
import { isLanguageSelector, looksLikeAppShell } from "../extract/app-shell.ts";
import { type FetchUrlGate, fetchText } from "../fetch/fetcher.ts";
import { filteredNonPageResult, robotsBlockedResult } from "../fetch/result.ts";
import { discoverAssetPages } from "./assets.ts";
import { canonicalOriginSeed, literalAllowPrefix } from "./blocked-seed.ts";
import {
	discoverLlmsCorpus,
	discoverLlmsUrls,
	type LlmsCorpusOptions,
	resourceAllowed,
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
import { loadRobots, type Robots } from "./robots.ts";
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

// Discovery has two distinct stages. First the *resolution* stage decides which
// public artifact a seed actually addresses: a single page, a robots-blocked
// origin's carve-outs, an llms.txt corpus, a feed, or an ordinary HTML seed.
// Each resolver either returns a complete corpus (short-circuit) or yields the
// resolved HTML seed for the second stage. The second stage is the *probe
// runner*: a fixed-order list of probes that accumulate scoped pages into a
// shared DiscoveryContext until one declares the corpus complete or max is hit.
export async function discover(
	config: PipelineConfig,
): Promise<DiscoveredUrl[]> {
	const inputSeed = seedInputUrl(config.seedUrl);
	const inputUrl = new URL(inputSeed);
	const seedRobots = await loadRobots(inputUrl.origin, config);

	if (config.pageOnly) return pageOnlyDiscovery(config, inputSeed, seedRobots);

	const robotsByOrigin: LlmsCorpusOptions["robotsByOrigin"] = new Map([
		[inputUrl.origin, seedRobots],
	]);
	const llmsOptions: LlmsCorpusOptions = { cache: new Map(), robotsByOrigin };
	const allowResource: FetchUrlGate | undefined = config.ignoreRobots
		? undefined
		: (url) => resourceAllowed(url, config, robotsByOrigin);

	const blocked = await resolveBlockedSeed(
		config,
		inputSeed,
		seedRobots,
		llmsOptions,
		allowResource,
	);
	if (blocked) return blocked;

	const corpus = await resolveLlmsCorpus(config, inputSeed, llmsOptions);
	if ("done" in corpus) return corpus.done;

	const seedResponse = await fetchText(
		inputSeed,
		config,
		undefined,
		undefined,
		allowResource,
	);
	if (!seedResponse.ok) {
		return [{ url: inputSeed, source: "seed", fetched: seedResponse }];
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
	if ("done" in resolved) return resolved.done;

	return runProbes(resolved.context);
}

type DiscoveryContext = {
	config: PipelineConfig;
	inputSeed: string;
	seed: string;
	scope: string;
	robots: Robots;
	allowed: (url: string) => boolean;
	allowResource: FetchUrlGate | undefined;
	llmsOptions: LlmsCorpusOptions;
	seedResponse: FetchResult;
	seedLinks: string[];
	feedLinks: string[];
	seedIsShell: boolean;
	seedIsLanguageSelector: boolean;
	finalSeed: string | undefined;
	out: DiscoveredUrl[];
	seen: Set<string>;
	// When true, add() refuses to exceed config.max. The initial seed/llms probes
	// run with this off so a complete llms corpus is captured intact; the bounded
	// probes that follow turn it on.
	limitToMax: boolean;
	// Set by the sitemap probe; a rich sitemap suppresses feed probing.
	richSitemap: boolean;
	add: AddDiscovered;
	atMax: () => boolean;
	remaining: () => number;
};

type AddDiscovered = (
	raw: string | undefined,
	source: DiscoverySource,
	fetched?: DiscoveredUrl["fetched"],
	metadata?: DiscoveredUrl["metadata"],
) => boolean;

// A probe inspects the context, adds scoped pages, and returns true to stop the
// runner (the corpus is complete) or false to fall through to the next probe.
type DiscoveryProbe = (ctx: DiscoveryContext) => Promise<boolean> | boolean;

// Probe order IS the precedence hierarchy. Each entry runs in turn; the first
// that returns true ends discovery. Each probe self-limits against config.max
// (via ctx.add and its own guards), so the runner imposes no global cap — the
// terminal asset/fallback probes must still run even once the corpus is full.
const probes: DiscoveryProbe[] = [
	addSeedPage,
	probeLlmsOverNav,
	probeNavAndCrawl,
	probeSitemap,
	probeFeeds,
	probeLlmsBackfill,
	probeRelNext,
	probeScopedCrawl,
	probeAssetMining,
	ensureSeedFallback,
];

async function runProbes(ctx: DiscoveryContext): Promise<DiscoveredUrl[]> {
	for (const probe of probes) {
		if (await probe(ctx)) break;
	}
	return ctx.out;
}

function pageOnlyDiscovery(
	config: PipelineConfig,
	inputSeed: string,
	seedRobots: Robots,
): DiscoveredUrl[] {
	const pageSeed = pageSeedUrl(config.seedUrl, inputSeed);
	if (!seedRobots.allowed(pageSeed)) {
		return [
			{ url: pageSeed, source: "seed", fetched: robotsBlockedResult(pageSeed) },
		];
	}
	return [{ url: pageSeed, source: "seed" }];
}

// Robots refuses the seed: either restart on a related canonical origin (apex →
// www), or fall back to the disallowed-seed carve-out discovery. Returns a
// complete corpus, or undefined when the seed is in fact allowed.
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
		if (moved) return discover({ ...config, seedUrl: moved });
		return [
			{
				url: inputSeed,
				source: "seed",
				fetched: failure ?? robotsBlockedResult(inputSeed),
			},
		];
	}
	return disallowedSeedDiscovery(inputSeed, seedRobots, config, llmsOptions);
}

// llms.txt takes precedence over fetching the seed at all. The four shapes — an
// explicit /llms.txt seed, scope-local corpus, root-fallback corpus, and the
// "corpus is enough" cutoff — collapse here. Returns a complete corpus (done)
// when an llms.txt corpus is strong enough to short-circuit, otherwise the
// scope-local llmsOut so later redirect-fallback logic can compare against it.
async function resolveLlmsCorpus(
	config: PipelineConfig,
	inputSeed: string,
	llmsOptions: LlmsCorpusOptions,
): Promise<{ done: DiscoveredUrl[] } | { llmsOut: DiscoveredUrl[] }> {
	const inputUrl = new URL(inputSeed);
	if (inputUrl.pathname.endsWith("/llms.txt")) {
		return {
			done: await discoverLlmsCorpus(inputSeed, inputSeed, "/", config, {
				...llmsOptions,
				retryHttp: true,
			}),
		};
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
		if (rootLlmsOut.length > llmsOut.length) return { done: rootLlmsOut };
	}
	if (inputScope === "/" ? llmsOut.length > 0 : hasCorpus(llmsOut, config)) {
		return { done: llmsOut };
	}
	return { llmsOut };
}

// A seed that resolves to a feed (RSS/Atom) is its own corpus shape: walk the
// feed entries rather than crawling. Returns the feed corpus, or undefined when
// the seed is not a feed.
async function resolveFeedSeed(
	config: PipelineConfig,
	inputSeed: string,
	seedResponse: FetchResult,
	robotsByOrigin: Map<string, Robots>,
	allowResource: FetchUrlGate | undefined,
): Promise<DiscoveredUrl[] | undefined> {
	if (!isFeedResponse(seedResponse)) return undefined;
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
			{
				url: feedSeed,
				source: "seed",
				fetched: robotsBlockedResult(seedResponse),
			},
		];
	}
	return discoverFeed(feedSeed, feedSeed, scopeFromSeed(feedSeed), config, {
		limit: config.max,
		response: seedResponse,
		accept: allowed,
		allowResource,
	});
}

// Resolve the final HTML seed: follow redirects, choose the crawl scope, gate on
// robots, and try redirect-adjusted / root-fallback llms corpora that only
// become reachable after the redirect. Either returns a complete corpus (done)
// or the assembled DiscoveryContext for the probe runner.
async function resolveHtmlSeed(
	config: PipelineConfig,
	inputSeed: string,
	seedResponse: FetchResult,
	llmsOut: DiscoveredUrl[],
	llmsOptions: LlmsCorpusOptions,
	robotsByOrigin: Map<string, Robots>,
): Promise<{ done: DiscoveredUrl[] } | { context: DiscoveryContext }> {
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
	const allowed = (url: string) => config.ignoreRobots || robots.allowed(url);
	if (!allowed(seed)) {
		return {
			done: [
				{
					url: seed,
					source: "seed",
					fetched: robotsBlockedResult(seedResponse),
				},
			],
		};
	}

	const redirected = await resolveRedirectAdjustedLlms(
		config,
		inputSeed,
		inputScope,
		seed,
		scope,
		llmsOut,
		llmsOptions,
	);
	if (redirected) return { done: redirected };

	const seedIsShell =
		seedIsLanguageSelector || looksLikeAppShell(seedResponse.body);
	const context = makeContext({
		config,
		seed,
		scope,
		robots,
		allowed,
		allowResource: config.ignoreRobots
			? undefined
			: (url) => resourceAllowed(url, config, robotsByOrigin),
		llmsOptions,
		seedResponse,
		seedLinks,
		feedLinks,
		seedIsShell,
		seedIsLanguageSelector,
		finalSeed,
		inputSeed,
	});
	return { context };
}

// After a redirect changes the effective seed or scope, an llms.txt corpus may
// now resolve at the redirected location or the bare-product root. Returns that
// corpus when it is strong enough to replace crawling, else undefined. llmsOut
// is the original input-scope corpus the root fallback must beat.
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
	return undefined;
}

function makeContext(
	parts: Omit<
		DiscoveryContext,
		| "out"
		| "seen"
		| "limitToMax"
		| "richSitemap"
		| "add"
		| "atMax"
		| "remaining"
	>,
): DiscoveryContext {
	const out: DiscoveredUrl[] = [];
	const seen = new Set<string>(parts.finalSeed ? [] : [parts.inputSeed]);
	const ctx = {
		...parts,
		out,
		seen,
		// Explicit max caps from the start; implicit max stays uncapped until the
		// nav probe so a complete llms corpus is captured intact.
		limitToMax: parts.config.maxExplicit,
		richSitemap: false,
	} as DiscoveryContext;
	ctx.atMax = () => out.length >= ctx.config.max;
	ctx.remaining = () => ctx.config.max - out.length;
	ctx.add = (raw, source, fetched, metadata) => {
		if (ctx.limitToMax && ctx.atMax()) return false;
		const url = normalizeUrl(raw ?? "");
		if (!url || !ctx.allowed(url)) return false;
		const before = out.length;
		addDiscovered(
			out,
			seen,
			url,
			source,
			ctx.seed,
			ctx.scope,
			fetched,
			metadata,
		);
		return out.length > before;
	};
	return ctx;
}

function addSeedPage(ctx: DiscoveryContext): boolean {
	if (!ctx.seedIsShell && ctx.finalSeed) {
		ctx.add(ctx.seed, "seed", ctx.seedResponse);
	}
	return false;
}

// llms.txt links that survive scope filtering outrank nav/crawl: when implicit
// max gives no hard cap, a non-empty llms corpus is the whole answer.
async function probeLlmsOverNav(ctx: DiscoveryContext): Promise<boolean> {
	if (ctx.config.maxExplicit) return false;
	const beforeLlms = ctx.out.length;
	await addLlms(ctx);
	ctx.limitToMax = true;
	return ctx.out.length > beforeLlms;
}

function probeNavAndCrawl(ctx: DiscoveryContext): boolean {
	ctx.limitToMax = true;
	if (!ctx.seedResponse.ok) return false;
	for (const url of discoverNav(
		ctx.seedResponse.body,
		ctx.seedResponse.finalUrl,
	)) {
		if (ctx.seedIsShell && normalizeUrl(url) === ctx.seed) continue;
		ctx.add(url, "nav");
		if (ctx.atMax()) break;
	}
	if (ctx.out.length < Math.min(ctx.config.max, 3)) {
		for (const url of ctx.seedLinks) {
			if (ctx.seedIsShell && normalizeUrl(url) === ctx.seed) continue;
			ctx.add(url, "crawl");
			if (ctx.atMax()) break;
		}
	}
	return false;
}

async function probeSitemap(ctx: DiscoveryContext): Promise<boolean> {
	const beforeSitemap = ctx.out.length;
	const sitemapRemaining = ctx.remaining();
	const sitemapUrls = await discoverSitemaps(
		ctx.seed,
		ctx.robots.sitemaps,
		ctx.config,
		{
			limit: ctx.remaining(),
			scope: ctx.scope,
			accept: (url) =>
				!ctx.seen.has(url) &&
				inScope(url, ctx.seed, ctx.scope) &&
				ctx.allowed(url),
			allowResource: ctx.allowResource,
		},
	);
	for (const url of sitemapUrls) {
		ctx.add(url, "sitemap");
	}
	const sitemapAdded = ctx.out.length - beforeSitemap;
	const richSitemap =
		sitemapRemaining > 0 &&
		(sitemapAdded >= sitemapRemaining ||
			sitemapAdded >= Math.min(sitemapRemaining, 5));
	// Record richness for the feed probe; a rich sitemap suppresses feed probing.
	ctx.richSitemap = richSitemap;
	return false;
}

async function probeFeeds(ctx: DiscoveryContext): Promise<boolean> {
	if (ctx.richSitemap || ctx.out.length >= Math.min(ctx.config.max, 3)) {
		return false;
	}
	for (const feedUrl of ctx.feedLinks.slice(0, 2)) {
		if (ctx.allowResource && !(await ctx.allowResource(feedUrl))) continue;
		const feedPages = await discoverFeed(
			feedUrl,
			ctx.seed,
			ctx.scope,
			ctx.config,
			{
				limit: ctx.remaining(),
				accept: (url) => inScope(url, ctx.seed, ctx.scope) && ctx.allowed(url),
				allowResource: ctx.allowResource,
			},
		);
		for (const page of feedPages) {
			ctx.add(page.url, "feed", page.fetched, page.metadata);
		}
		if (ctx.atMax()) break;
	}
	return false;
}

// Under explicit max the llms corpus is not the whole answer (probeLlmsOverNav
// skipped it), so backfill remaining slots from llms.txt after the primary
// sources have run.
async function probeLlmsBackfill(ctx: DiscoveryContext): Promise<boolean> {
	if (ctx.config.maxExplicit && !ctx.atMax()) await addLlms(ctx);
	return false;
}

async function probeRelNext(ctx: DiscoveryContext): Promise<boolean> {
	if (ctx.out.length >= Math.min(ctx.config.max, 3)) return false;
	for (const page of await discoverRelNextPages(
		ctx.seedResponse.body,
		ctx.seedResponse.finalUrl,
		ctx.seed,
		ctx.scope,
		ctx.config,
		{
			limit: ctx.remaining(),
			accept: (url) => inScope(url, ctx.seed, ctx.scope) && ctx.allowed(url),
			allowResource: ctx.allowResource,
		},
	)) {
		ctx.add(page.url, page.source, page.fetched, page.metadata);
	}
	return false;
}

async function probeScopedCrawl(ctx: DiscoveryContext): Promise<boolean> {
	if (ctx.seedIsLanguageSelector || ctx.atMax()) return false;
	for (const page of await crawlScoped(
		ctx.seed,
		ctx.scope,
		ctx.remaining(),
		ctx.robots,
		ctx.config,
		ctx.seedResponse,
		ctx.allowResource,
	)) {
		ctx.add(page.url, "crawl", page.fetched);
	}
	return false;
}

// Last resort for app shells: mine JS asset text for route URLs. When it finds a
// corpus it replaces everything (returns true) rather than mixing with the lone
// seed page.
async function probeAssetMining(ctx: DiscoveryContext): Promise<boolean> {
	if (ctx.out.length > 1 || !ctx.seedResponse.ok) return false;
	const assetPages = await discoverAssetPages(
		ctx.seed,
		ctx.seedResponse.body,
		ctx.config,
		{
			limit: ctx.config.max,
			scope: ctx.scope,
			accept: (url) =>
				!ctx.seen.has(url) &&
				inScope(url, ctx.seed, ctx.scope) &&
				ctx.allowed(url),
			allowResource: ctx.allowResource,
		},
	);
	if (assetPages.length === 0) return false;
	ctx.out.length = 0;
	ctx.out.push(...assetPages);
	return true;
}

// Nothing matched. When the seed never resolved (no finalSeed), report an honest
// filtered non-page result keyed to the original input seed so the run surfaces
// the real reason. Otherwise re-add the resolved seed so the corpus is non-empty.
function ensureSeedFallback(ctx: DiscoveryContext): boolean {
	if (ctx.out.length > 0) return false;
	if (!ctx.finalSeed) {
		const r = ctx.seedResponse;
		ctx.out.push({
			url: ctx.inputSeed,
			source: "seed",
			fetched: filteredNonPageResult(r.url, r.finalUrl, {
				redirects: r.redirects ?? [],
				status: r.status,
				contentType: r.contentType,
				body: r.body,
				fetchMs: r.fetchMs,
			}),
		});
		return true;
	}
	ctx.add(ctx.seed, "seed", ctx.seedResponse);
	return false;
}

function seedInputUrl(raw: string) {
	if (looksLikeFeedResourceUrl(raw)) {
		return normalizeDiscoveryResourceUrl(raw) ?? raw;
	}
	return normalizeUrl(raw) ?? normalizeDiscoveryResourceUrl(raw) ?? raw;
}

// In --page mode the user asks for one exact public page; preserve any query so
// query-addressed content (e.g. ?version=2) is fetched as requested rather than
// collapsed to the bare path by seed normalization.
function pageSeedUrl(raw: string, normalized: string) {
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

function hasCorpus(out: DiscoveredUrl[], config: PipelineConfig) {
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

async function addLlms(ctx: DiscoveryContext) {
	for (const url of await discoverLlmsUrls(
		ctx.seed,
		ctx.config,
		ctx.llmsOptions,
	)) {
		ctx.add(url, "llms");
	}
}

// only for the robots-disallowed seed carve-out: on a Disallow:/ origin a
// robots-declared sitemap is the site's own explicit invitation, so it may be
// fetched even though its path is disallowed. The normal allowed-seed path must
// NOT use this — there a declared sitemap stays subject to allowResource so a
// robots Disallow is never overridden by also declaring the sitemap.
function declaredSitemapInvitationGate(
	declared: string[],
	allowResource: ((url: string) => Promise<boolean>) | undefined,
) {
	if (!allowResource) return undefined;
	const declaredSet = new Set(declared);
	return (url: string) => declaredSet.has(url) || allowResource(url);
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

// a robots-disallowed seed often sits on a site that carves out Allow:
// subtrees and declares sitemaps; honor those explicit signals without ever
// fetching the seed itself or probing undeclared sitemap paths
async function disallowedSeedDiscovery(
	inputSeed: string,
	robots: Robots,
	config: PipelineConfig,
	llmsOptions: LlmsCorpusOptions,
): Promise<DiscoveredUrl[]> {
	const out = await discoverLlmsCorpus(
		inputSeed,
		inputSeed,
		"/",
		config,
		llmsOptions,
	);
	const seen = new Set(out.map((item) => item.url));
	const allowResource = config.ignoreRobots
		? undefined
		: (url: string) => resourceAllowed(url, config, llmsOptions.robotsByOrigin);
	if (robots.sitemaps.length > 0 && out.length < config.max) {
		const sitemapUrls = await discoverSitemaps(
			inputSeed,
			robots.sitemaps,
			config,
			{
				limit: config.max - out.length,
				scope: "/",
				declaredOnly: true,
				accept: (url) => !seen.has(url) && robots.allowed(url),
				allowResource: declaredSitemapInvitationGate(
					robots.sitemaps,
					allowResource,
				),
			},
		);
		for (const url of sitemapUrls) {
			if (seen.has(url) || !robots.allowed(url)) continue;
			seen.add(url);
			out.push({ url, source: "sitemap" });
		}
	}
	if (out.length > 0) return out;
	// no corpus and no declared sitemap: a literal Allow prefix (no wildcards)
	// is an explicit entry invitation — restart discovery seeded there
	const prefix = literalAllowPrefix(robots, inputSeed);
	if (prefix) return discover({ ...config, seedUrl: prefix });
	return [
		{ url: inputSeed, source: "seed", fetched: robotsBlockedResult(inputSeed) },
	];
}
