import type { DiscoveredUrl, PipelineConfig } from "../core/types.ts";
import {
	isLlmsResourcePath,
	relatedHost,
	sameSharedHostPlatform,
} from "../core/url.ts";
import { discoverLlms, type LlmsDiscoveryOptions } from "./llms.ts";
import { loadRobots } from "./robots.ts";
import { candidateWindow, orderByTopic } from "./topic.ts";
import { addDiscovered, normalizeUrl, pathInScope } from "./url.ts";

export type LlmsCorpusOptions = LlmsDiscoveryOptions;

export async function discoverLlmsUrls(
	seed: string,
	config: PipelineConfig,
	options: LlmsCorpusOptions,
	limit?: number,
) {
	const allowResource = (url: string) => resourceAllowed(url, config);
	const discoveryOptions = {
		...options,
		allowResource,
	};
	return discoverLlms(
		seed,
		config,
		limit === undefined ? discoveryOptions : { ...discoveryOptions, limit },
	);
}

export async function resourceAllowed(url: string, config: PipelineConfig) {
	const robots = await loadRobots(new URL(url).origin, config);
	return robots.allowed(url);
}

export async function discoverLlmsCorpus(
	seed: string,
	sourceSeed: string,
	scope: string,
	config: PipelineConfig,
	options: LlmsCorpusOptions,
	limit = config.max,
) {
	const llmsUrls = await discoverLlmsUrls(
		seed,
		config,
		options,
		candidateWindow(config, limit),
	);
	const corpus = corpusTarget(seed, llmsUrls);
	const out: DiscoveredUrl[] = [];
	const seen = new Set<string>();
	const rankedUrls = orderByTopic(llmsUrls, sourceSeed, scope);
	for (const raw of rankedUrls) {
		const url = normalizeUrl(raw);
		if (
			!url ||
			isLlmsResourcePath(new URL(url).pathname) ||
			!inCorpus(url, sourceSeed, scope, corpus)
		)
			continue;
		const origin = new URL(url).origin;
		if (!(await resourceAllowed(url, config))) continue;
		const corpusMatch = corpus && origin === corpus.origin;
		const targetSeed = corpusMatch
			? `${corpus.origin}${corpus.scope}`
			: sourceSeed;
		const targetScope = corpusMatch ? corpus.scope : scope;
		addDiscovered(out, seen, url, "llms", targetSeed, targetScope);
		if (config.maxExplicit && out.length >= limit) break;
	}
	return out;
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
		relatedHost(seedUrl.hostname, targetHost) || strongSharedHostCorpus;
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
