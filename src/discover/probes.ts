import type {
	DiscoveredUrl,
	DiscoverySource,
	FetchResult,
	PipelineConfig,
} from "../core/types.ts";
import type { FetchUrlGate } from "../fetch/fetcher.ts";
import { emptyResourceResult, filteredNonPageResult } from "../fetch/result.ts";
import { discoverAssetPages } from "./assets.ts";
import { discoverLlmsUrls, type LlmsCorpusOptions } from "./corpus.ts";
import { crawlScoped } from "./crawl.ts";
import { discoverFeed, discoverRelNextPages } from "./feed.ts";
import { discoverNav } from "./nav.ts";
import type { Robots } from "./robots.ts";
import { discoverSitemaps } from "./sitemap.ts";
import { candidateWindowConfig, orderByTopic } from "./topic.ts";
import { addDiscovered, inScope, normalizeUrl } from "./url.ts";

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
	limitToMax: boolean;
	richSitemap: boolean;
	add: (
		raw: string | undefined,
		source: DiscoverySource,
		fetched?: DiscoveredUrl["fetched"],
		metadata?: DiscoveredUrl["metadata"],
	) => boolean;
	atMax: () => boolean;
	remaining: () => number;
};

export type DiscoveryProbeInput = Omit<
	DiscoveryContext,
	"out" | "seen" | "limitToMax" | "richSitemap" | "add" | "atMax" | "remaining"
>;

function makeContext(parts: DiscoveryProbeInput): DiscoveryContext {
	const out: DiscoveredUrl[] = [];
	const seen = new Set<string>(parts.finalSeed ? [] : [parts.inputSeed]);
	const ctx: DiscoveryContext = {
		...parts,
		out,
		seen,
		limitToMax: parts.config.maxExplicit,
		richSitemap: false,
		atMax: () => out.length >= ctx.config.max,
		remaining: () => ctx.config.max - out.length,
		add: (raw, source, fetched, metadata) => {
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
		},
	};
	return ctx;
}

export async function runProbes(
	input: DiscoveryProbeInput,
): Promise<DiscoveryContext["out"]> {
	const ctx = makeContext(input);
	addSeedPage(ctx);
	if (await probeLlmsOverNav(ctx)) return ctx.out;
	probeNavAndCrawl(ctx);
	await probeSitemap(ctx);
	await probeFeeds(ctx);
	await probeLlmsBackfill(ctx);
	await probeRelNext(ctx);
	await probeScopedCrawl(ctx);
	if (await probeAssetMining(ctx)) return ctx.out;
	ensureSeedFallback(ctx);
	return ctx.out;
}

function addSeedPage(ctx: DiscoveryContext) {
	if (!ctx.seedIsShell && ctx.finalSeed) {
		ctx.add(ctx.seed, "seed", ctx.seedResponse);
	}
}

async function probeLlmsOverNav(ctx: DiscoveryContext): Promise<boolean> {
	if (ctx.config.maxExplicit) return false;
	const beforeLlms = ctx.out.length;
	await addLlms(ctx);
	ctx.limitToMax = true;
	return ctx.out.length > beforeLlms;
}

function probeNavAndCrawl(ctx: DiscoveryContext) {
	ctx.limitToMax = true;
	if (!ctx.seedResponse.ok) return;
	if (ctx.config.maxExplicit) {
		addOrderedLinks(ctx, ctx.seedLinks, "crawl");
		addOrderedLinks(
			ctx,
			discoverNav(ctx.seedResponse.body, ctx.seedResponse.finalUrl),
			"nav",
		);
		return;
	}
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
}

function addOrderedLinks(
	ctx: DiscoveryContext,
	links: string[],
	source: "crawl" | "nav",
) {
	for (const url of orderByTopic(links, ctx.seed, ctx.scope)) {
		if (ctx.seedIsShell && normalizeUrl(url) === ctx.seed) continue;
		ctx.add(url, source);
		if (ctx.atMax()) break;
	}
}

async function probeSitemap(ctx: DiscoveryContext) {
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
	ctx.richSitemap = richSitemap;
}

async function probeFeeds(ctx: DiscoveryContext) {
	if (ctx.richSitemap || ctx.out.length >= Math.min(ctx.config.max, 3)) {
		return;
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
}

async function probeLlmsBackfill(ctx: DiscoveryContext) {
	if (ctx.config.maxExplicit && !ctx.atMax()) await addLlms(ctx);
}

async function probeRelNext(ctx: DiscoveryContext) {
	if (ctx.out.length >= Math.min(ctx.config.max, 3)) return;
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
}

async function probeScopedCrawl(ctx: DiscoveryContext) {
	if (ctx.seedIsLanguageSelector || ctx.atMax()) return;
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
}

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
	if (ctx.seedIsShell) {
		ctx.out.push({
			url: ctx.seed,
			source: "seed",
			wasSeed: true,
			fetched: emptyResourceResult(
				ctx.seedResponse,
				"app shell without static text",
			),
		});
	}
	ctx.out.push(...assetPages);
	return true;
}

function ensureSeedFallback(ctx: DiscoveryContext) {
	if (ctx.out.length > 0) return;
	if (!ctx.finalSeed) {
		const r = ctx.seedResponse;
		ctx.out.push({
			url: ctx.inputSeed,
			source: "seed",
			wasSeed: true,
			fetched: filteredNonPageResult(r.url, r.finalUrl, {
				redirects: r.redirects ?? [],
				status: r.status,
				contentType: r.contentType,
				body: r.body,
				fetchMs: r.fetchMs,
			}),
		});
		return;
	}
	ctx.add(ctx.seed, "seed", ctx.seedResponse);
}

async function addLlms(ctx: DiscoveryContext) {
	const urls = await discoverLlmsUrls(
		ctx.seed,
		candidateWindowConfig(ctx.config),
		ctx.llmsOptions,
	);
	for (const url of orderByTopic(urls, ctx.seed, ctx.scope)) {
		ctx.add(url, "llms");
	}
}
