import type {
	DiscoveredUrl,
	FetchResult,
	PipelineConfig,
} from "../core/types.ts";
import {
	isLlmsResourcePath,
	relatedHost,
	sameSharedHostPlatform,
	sameSiteLabel,
} from "../core/url.ts";
import { robotsBlockedResult } from "../fetch/result.ts";
import {
	discoverLlms,
	type LlmsDiscoveryOptions,
	llmsCandidateUrls,
} from "./llms.ts";
import { loadRobots, type Robots } from "./robots.ts";
import { candidateWindowConfig, orderByTopic } from "./topic.ts";
import { addDiscovered, normalizeUrl, pathInScope } from "./url.ts";

export type LlmsCorpusOptions = LlmsDiscoveryOptions & {
	robotsByOrigin: Map<string, Robots>;
};

export async function discoverLlmsUrls(
	seed: string,
	config: PipelineConfig,
	options: LlmsCorpusOptions,
) {
	await cacheRobotsBlockedLlmsCandidates(seed, config, options);
	const allowResource = (url: string) =>
		resourceAllowed(url, config, options.robotsByOrigin);
	return discoverLlms(seed, config, { ...options, allowResource });
}

export async function resourceAllowed(
	url: string,
	config: PipelineConfig,
	robotsByOrigin: Map<string, Robots>,
) {
	const robots = await robotsForOrigin(
		new URL(url).origin,
		config,
		robotsByOrigin,
	);
	return robots.allowed(url);
}

export async function discoverLlmsCorpus(
	seed: string,
	sourceSeed: string,
	scope: string,
	config: PipelineConfig,
	options: LlmsCorpusOptions,
) {
	const llmsUrls = await discoverLlmsUrls(
		seed,
		candidateWindowConfig(config),
		options,
	);
	const corpus = corpusTarget(seed, llmsUrls);
	const out: DiscoveredUrl[] = [];
	const seen = new Set<string>();
	const rankedUrls = orderByTopic(llmsUrls, sourceSeed, scope);
	for (const raw of rankedUrls) {
		const url = normalizeUrl(raw);
		if (
			!url ||
			isLlmsResource(url) ||
			!inCorpus(url, sourceSeed, scope, corpus)
		)
			continue;
		const parsed = new URL(url);
		const origin = parsed.origin;
		const robots = await robotsForOrigin(
			origin,
			config,
			options.robotsByOrigin,
		);
		if (!robots.allowed(url)) continue;
		const corpusMatch = corpus && origin === corpus.origin;
		const targetSeed = corpusMatch
			? `${corpus.origin}${corpus.scope}`
			: sourceSeed;
		const targetScope = corpusMatch ? corpus.scope : scope;
		addDiscovered(out, seen, url, "llms", targetSeed, targetScope);
		if (config.maxExplicit && out.length >= config.max) break;
	}
	return out;
}

function isLlmsResource(url: string) {
	return isLlmsResourcePath(new URL(url).pathname);
}

export async function robotsForOrigin(
	origin: string,
	config: PipelineConfig,
	robotsByOrigin: Map<string, Robots>,
) {
	let robots = robotsByOrigin.get(origin);
	if (!robots) {
		robots = await loadRobots(origin, config);
		robotsByOrigin.set(origin, robots);
	}
	return robots;
}

async function cacheRobotsBlockedLlmsCandidates(
	seed: string,
	config: PipelineConfig,
	options: LlmsCorpusOptions,
) {
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

function inCorpus(
	url: string,
	sourceSeed: string,
	scope: string,
	corpus: { origin: string; scope: string } | undefined,
) {
	const parsed = new URL(url);
	const source = new URL(sourceSeed);
	if (parsed.origin === source.origin)
		return pathInScope(parsed.pathname, scope);
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
	// the scope is a directory prefix with a trailing slash; if the common prefix
	// consumes a whole file path (a URL that ends exactly here and is not a
	// "/"-terminated directory), back off to its parent dir so that file still
	// matches pathInScope's startsWith check instead of being excluded
	const consumesFile = urls.some(
		(url, index) =>
			paths[index]!.length === length && !url.pathname.endsWith("/"),
	);
	if (consumesFile && length > 0) length--;
	return length > 0 ? `/${paths[0]!.slice(0, length).join("/")}/` : "/";
}

function mostlyCorpusFiles(urls: URL[]) {
	return (
		urls.filter((url) => /\.(mdx?|txt|ya?ml|json)$/i.test(url.pathname))
			.length >=
		urls.length * 0.8
	);
}
