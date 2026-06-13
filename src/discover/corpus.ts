import type { Config, DiscoveredUrl, FetchResult } from "../core/types.ts";
import {
	relatedHost,
	sameSharedHostPlatform,
	sameSiteLabel,
} from "../core/url.ts";
import { robotsBlockedResult } from "../fetch/result.ts";
import { discoverLlms, type LlmsDiscoveryOptions } from "./llms.ts";
import { loadRobots, type Robots } from "./robots.ts";
import { addDiscovered, normalizeUrl, pathInScope } from "./url.ts";

export type LlmsCorpusOptions = LlmsDiscoveryOptions & {
	robotsByOrigin: Map<string, Robots>;
};

export async function discoverLlmsUrls(
	seed: string,
	config: Config,
	options: LlmsCorpusOptions,
) {
	await blockDisallowedLlmsCandidates(seed, config, options);
	const allowResource = async (url: string) => {
		if (config.ignoreRobots) return true;
		const robots = await robotsForOrigin(
			new URL(url).origin,
			config,
			options.robotsByOrigin,
		);
		return robots.allowed(url);
	};
	return discoverLlms(seed, config, { ...options, allowResource });
}

export async function discoverLlmsCorpus(
	seed: string,
	sourceSeed: string,
	scope: string,
	config: Config,
	options: LlmsCorpusOptions,
) {
	const llmsUrls = await discoverLlmsUrls(seed, config, options);
	const corpus = corpusTarget(seed, llmsUrls);
	const includeRootLlms =
		!corpus && hasScopedSameOriginLinks(llmsUrls, sourceSeed, scope);
	const out: DiscoveredUrl[] = [];
	const seen = new Set<string>();
	const sourceOrigin = new URL(sourceSeed).origin;
	for (const raw of llmsUrls) {
		const url = normalizeUrl(raw);
		if (!url || !inCorpus(url, sourceSeed, scope, corpus)) continue;
		const parsed = new URL(url);
		const origin = parsed.origin;
		const robots = await robotsForOrigin(
			origin,
			config,
			options.robotsByOrigin,
		);
		if (!config.ignoreRobots && !robots.allowed(url)) continue;
		const rootLlms =
			includeRootLlms &&
			origin === sourceOrigin &&
			parsed.pathname === "/llms.txt";
		const corpusMatch = corpus && origin === corpus.origin;
		const targetSeed = rootLlms
			? `${origin}/`
			: corpusMatch
				? `${corpus.origin}${corpus.scope}`
				: sourceSeed;
		const targetScope = rootLlms ? "/" : corpusMatch ? corpus.scope : scope;
		addDiscovered(out, seen, url, "llms", targetSeed, targetScope);
		if (config.maxExplicit && out.length >= config.max) break;
	}
	return out;
}

export async function robotsForOrigin(
	origin: string,
	config: Config,
	robotsByOrigin: Map<string, Robots>,
) {
	let robots = robotsByOrigin.get(origin);
	if (!robots) {
		robots = await loadRobots(origin, config);
		robotsByOrigin.set(origin, robots);
	}
	return robots;
}

async function blockDisallowedLlmsCandidates(
	seed: string,
	config: Config,
	options: LlmsCorpusOptions,
) {
	if (config.ignoreRobots) return;
	const cache = options.cache ?? new Map<string, Promise<FetchResult>>();
	options.cache = cache;
	for (const url of llmsCandidateUrls(seed)) {
		const robots = await robotsForOrigin(
			new URL(url).origin,
			config,
			options.robotsByOrigin,
		);
		if (!robots.allowed(url)) {
			cache.set(url, Promise.resolve(robotsBlockedResult(url)));
		}
	}
}

function llmsCandidateUrls(seed: string) {
	const base = new URL(seed);
	const dir = base.pathname.endsWith("/")
		? base.pathname
		: base.pathname.replace(/\/[^/]*$/, "/");
	const paths = new Set<string>();
	if (base.pathname.endsWith("/")) paths.add(`${base.pathname}llms.txt`);
	else if (!/\.[a-z0-9]+$/i.test(base.pathname))
		paths.add(`${base.pathname}/llms.txt`);
	paths.add(`${dir}llms.txt`);
	paths.add("/llms.txt");
	return [...paths].map((path) => `${base.origin}${path}`);
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
	const redirectedRootLlms = best?.[1].some(
		(url) => url.pathname === "/llms.txt",
	);
	if (!best || (!redirectedRootLlms && best[1].length < 5)) return undefined;
	const targetHost = new URL(best[0]).hostname;
	const scope = commonScope(best[1]);
	const strongSharedHostCorpus =
		best[1].length >= 5 &&
		scope !== "/" &&
		sameSharedHostPlatform(seedUrl.hostname, targetHost);
	const trustedHost =
		relatedHost(seedUrl.hostname, targetHost) ||
		sameSiteLabel(seedUrl.hostname, targetHost) ||
		strongSharedHostCorpus;
	if (!trustedHost) return undefined;
	if (!fileHeavy && scope === "/" && !redirectedRootLlms) return undefined;
	return { origin: best[0], scope };
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
