import { maxGeneratedCapturePages } from "../core/config.ts";
import { markdownLinkHrefs } from "../core/markdown.ts";
import type { FetchResult, PipelineConfig } from "../core/types.ts";
import { isLlmsResourcePath } from "../core/url.ts";
import { fetchText, preferredMarkdownAccept } from "../fetch/fetcher.ts";
import { orderByTopic } from "./topic.ts";
import {
	normalizeUrl,
	pathAllowed,
	sameScopeLinks,
	scopeFromSeed,
} from "./url.ts";

const CORPUS_INDEX_LIMIT = 256;
export type LlmsDiscoveryOptions = {
	cache?: Map<string, Promise<FetchResult>>;
	allowResource?: (url: string) => Promise<boolean> | boolean;
	limit?: number;
	truncated?: boolean;
};

export async function discoverLlms(
	seed: string,
	config: PipelineConfig,
	options: LlmsDiscoveryOptions = {},
): Promise<string[]> {
	const requestedScope = scopeFromSeed(seed);
	const urls = new Set<string>();
	const seen = new Set<string>();
	const limit = config.maxExplicit
		? (options.limit ?? config.max)
		: maxGeneratedCapturePages;
	const scanLimit = config.maxExplicit ? limit : limit + 1;
	const queue = llmsCandidateUrls(seed);
	const fetchAllowed = async (url: string) => {
		if (
			!options.cache?.has(url) &&
			options.allowResource &&
			!(await options.allowResource(url))
		)
			return;
		return fetchLlmsText(url, config, options);
	};
	const initialUrls = queue.slice(
		0,
		Math.min(config.concurrency, config.perOrigin),
	);
	const initialResponses = await Promise.all(initialUrls.map(fetchAllowed));
	const initial = new Map(
		initialUrls.map((url, index) => [url, initialResponses[index]]),
	);
	while (
		queue.length > 0 &&
		seen.size < CORPUS_INDEX_LIMIT &&
		urls.size < scanLimit
	) {
		const llmsUrl = queue.shift()!;
		if (seen.has(llmsUrl)) continue;
		seen.add(llmsUrl);
		const response = initial.has(llmsUrl)
			? initial.get(llmsUrl)
			: await fetchAllowed(llmsUrl);
		if (!response) continue;
		if (!response.ok || !isLlmsCorpus(response.contentType, response.body))
			continue;
		const corpusBase = response.finalUrl;
		for (const link of corpusLinks(
			response.body,
			corpusBase,
			requestedScope,
			config,
		)) {
			const pathname = new URL(link).pathname;
			if (pathname === "/") continue;
			if (isLlmsResourcePath(pathname)) {
				if (!seen.has(link)) queue.push(link);
				continue;
			}
			if (!pathAllowed(link, config)) continue;
			if (shouldExpandIndex(link, corpusBase, seen, urls, scanLimit)) {
				urls.add(link);
				queue.push(link);
				if (urls.size >= scanLimit) break;
				continue;
			}
			urls.add(link);
			if (urls.size >= scanLimit) break;
		}
	}
	if (!config.maxExplicit && urls.size > limit) options.truncated = true;
	return [...urls].slice(0, limit);
}

function llmsCandidateUrls(seed: string): string[] {
	const base = new URL(seed);
	const dir = base.pathname.endsWith("/")
		? base.pathname
		: base.pathname.replace(/\/[^/]*$/, "/");
	const paths = new Set<string>();
	if (isLlmsResourcePath(base.pathname)) paths.add(base.pathname);
	if (base.pathname.endsWith("/")) paths.add(`${base.pathname}llms.txt`);
	else if (!/\.[a-z0-9]+$/i.test(base.pathname))
		paths.add(`${base.pathname}/llms.txt`);
	paths.add(`${dir}llms.txt`);
	paths.add("/llms.txt");
	return [...paths].map((path) => `${base.origin}${path}`);
}

function fetchLlmsText(
	url: string,
	config: PipelineConfig,
	options: LlmsDiscoveryOptions,
) {
	const cached = options.cache?.get(url);
	if (cached) return cached;
	const fetched = fetchText(
		url,
		config,
		preferredMarkdownAccept,
		undefined,
		options.allowResource,
	).then((response) => {
		if (response.finalUrl !== url) {
			options.cache?.set(response.finalUrl, Promise.resolve(response));
		}
		return response;
	});
	options.cache?.set(url, fetched);
	return fetched;
}

function isLlmsCorpus(contentType: string, body: string) {
	const text = body.trim();
	if (!text) return false;
	if (looksLikeHtml(text)) return false;
	const type = contentType.toLowerCase().split(";")[0]?.trim() ?? "";
	if (
		type &&
		!/^text\/(?:markdown|plain|x-markdown)$|^application\/(?:markdown|octet-stream)$/.test(
			type,
		)
	)
		return false;
	return looksLikeCorpus(text);
}

function looksLikeHtml(body: string) {
	const head = body.slice(0, 512).toLowerCase();
	return (
		head.includes("<!doctype html") ||
		head.includes("<html") ||
		head.includes("<head") ||
		head.includes("<body")
	);
}

function looksLikeCorpus(body: string) {
	return (
		/\[[^\]]+]\([^)\s][^)]*\)/.test(body) ||
		/(^|\n)\s*#\s+\S/m.test(body) ||
		/(^|\n)\s*[-*]\s+\S/m.test(body) ||
		/(^|\n)\s*https?:\/\/\S+/m.test(body) ||
		/(^|\n)\s*\/[^\s]+/m.test(body) ||
		/\bllms-(full|ctx|ctx-full)\.txt\b/i.test(body)
	);
}

function corpusLinks(
	body: string,
	base: string,
	requestedScope: string,
	config: PipelineConfig,
) {
	const links = corpusEntryLinks(body, base, maxGeneratedCapturePages + 1);
	const hasSmaller = links.some((link) => {
		const pathname = new URL(link).pathname;
		return pathname !== "/" && !isFullCorpusUrl(link);
	});
	const selected = hasSmaller
		? links.filter((link) => !isFullCorpusUrl(link))
		: links;
	if (!config.maxExplicit) return selected;
	return orderByTopic(selected, base, requestedScope);
}

function isFullCorpusUrl(raw: string) {
	return /(?:^|\/)llms-(?:full|ctx-full)\.txt$/i.test(new URL(raw).pathname);
}

function corpusEntryLinks(body: string, base: string, limit: number) {
	const links = new Set<string>();
	let start = 0;
	while (start <= body.length && links.size < limit) {
		const newline = body.indexOf("\n", start);
		const line = body.slice(start, newline < 0 ? body.length : newline);
		const first = markdownLinkHrefs(line, 1)[0];
		if (first !== undefined) {
			const url = normalizeUrl(first, base);
			if (url) links.add(url);
		} else {
			for (const url of sameScopeLinks(line, base, limit - links.size)) {
				links.add(url);
			}
		}
		if (newline < 0) break;
		start = newline + 1;
	}
	return [...links];
}

function shouldExpandIndex(
	raw: string,
	base: string,
	seen: Set<string>,
	urls: Set<string>,
	limit: number,
) {
	const url = new URL(raw);
	return (
		url.origin === new URL(base).origin &&
		url.pathname.endsWith("/index.md") &&
		!seen.has(url.href) &&
		urls.size < limit
	);
}
