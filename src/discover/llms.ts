import { markdownLinkHrefs } from "../core/markdown.ts";
import type { FetchResult, PipelineConfig } from "../core/types.ts";
import { isLlmsResourcePath } from "../core/url.ts";
import { fetchText, preferredMarkdownAccept } from "../fetch/fetcher.ts";
import { orderByTopic } from "./topic.ts";
import {
	normalizeUrl,
	pathInScope,
	sameScopeLinks,
	scopeFromSeed,
} from "./url.ts";

const CORPUS_INDEX_LIMIT = 256;
export type LlmsDiscoveryOptions = {
	cache?: Map<string, Promise<FetchResult>>;
	allowResource?: (url: string) => Promise<boolean> | boolean;
};

export async function discoverLlms(
	seed: string,
	config: PipelineConfig,
	options: LlmsDiscoveryOptions = {},
): Promise<string[]> {
	const requestedScope = scopeFromSeed(seed);
	const urls = new Set<string>();
	const seen = new Set<string>();
	const queue = llmsCandidateUrls(seed);
	const fetchAllowed = async (url: string) => {
		if (options.allowResource && !(await options.allowResource(url))) return;
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
		(!config.maxExplicit || urls.size < config.max)
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
		// redirects can land on a robots-disallowed URL; never use that content
		if (
			options.allowResource &&
			response.finalUrl !== llmsUrl &&
			!(await options.allowResource(response.finalUrl))
		)
			continue;
		const corpusBase = response.finalUrl;
		for (const link of corpusLinks(
			response.body,
			corpusBase,
			requestedScope,
			config,
		)) {
			if (new URL(link).pathname === "/") continue;
			if (isLlmsResourcePath(new URL(link).pathname)) {
				if (!seen.has(link)) queue.push(link);
				continue;
			}
			if (shouldExpandIndex(link, corpusBase, seen, urls, config)) {
				urls.add(link);
				queue.push(link);
				if (config.maxExplicit && urls.size >= config.max) break;
				continue;
			}
			urls.add(link);
			if (config.maxExplicit && urls.size >= config.max) break;
		}
	}
	return [...urls];
}

export function llmsCandidateUrls(seed: string): string[] {
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
		![
			"text/markdown",
			"text/plain",
			"text/x-markdown",
			"application/markdown",
			"application/octet-stream",
		].includes(type)
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
		// linear markdown-link probe: a single fixed first char + one greedy class
		// avoids the catastrophic backtracking of two adjacent overlapping quantifiers
		// on a crafted multi-MB llms.txt body with no closing paren (ReDoS)
		/\[[^\]]+]\([^)\s][^)]*\)/.test(body) ||
		/(^|\n)\s*#\s+\S/m.test(body) ||
		/(^|\n)\s*[-*]\s+\S/m.test(body) ||
		/(^|\n)\s*https?:\/\/\S+/m.test(body) ||
		/(^|\n)\s*\/[^\s]+/m.test(body) ||
		/\bllms-(full|ctx|ctx-full)\.txt\b/i.test(body)
	);
}

function guessFullCorpusUrls(body: string, base: string, explicit: string[]) {
	const hints: string[] = [];
	for (const name of ["llms-full.txt", "llms-ctx.txt", "llms-ctx-full.txt"]) {
		if (explicit.some((raw) => new URL(raw).pathname.endsWith(`/${name}`)))
			continue;
		const url = normalizeUrl(name, base);
		if (url && body.includes(name)) hints.push(url);
	}
	return hints;
}

function corpusLinks(
	body: string,
	base: string,
	requestedScope: string,
	config: PipelineConfig,
) {
	const explicit = corpusEntryLinks(body, base);
	const links = [
		...new Set([...explicit, ...guessFullCorpusUrls(body, base, explicit)]),
	];
	if (!config.maxExplicit) return links;
	const scopeRanked = links.sort(
		(a, b) =>
			linkRank(a, base, requestedScope) - linkRank(b, base, requestedScope),
	);
	return orderByTopic(scopeRanked, base, requestedScope, config.topic);
}

function corpusEntryLinks(body: string, base: string) {
	const links = new Set<string>();
	for (const line of body.split("\n")) {
		const first = markdownLinkHrefs(line)[0];
		if (first !== undefined) {
			const url = normalizeUrl(first, base);
			if (url) links.add(url);
			continue;
		}
		if (languageListingLine(line)) continue;
		for (const url of sameScopeLinks(line, base)) links.add(url);
	}
	return [...links];
}

function languageListingLine(line: string) {
	return (
		/\b\d+\s+pages\b/i.test(line) &&
		/(^|\s)\/docs(?:\/[a-z]{2}(?:-[a-z]{2})?)?(?:\s|$)/i.test(line)
	);
}

function isFullCorpus(raw: string) {
	return /(^|\/)llms-full\.txt$/i.test(new URL(raw).pathname);
}

function linkRank(raw: string, base: string, requestedScope: string) {
	const scope = base.replace(/\/[^/]*$/, "/");
	const url = new URL(raw);
	return (
		Number(!pathInScope(url.pathname, requestedScope)) * 4 +
		Number(!pathInScope(url.pathname, new URL(scope).pathname)) +
		Number(isFullCorpus(raw)) * 2 +
		lowValueCorpusPathRank(url.pathname)
	);
}

function lowValueCorpusPathRank(pathname: string) {
	return /(?:^|\/)(?:widgets?|playground|chat)\//i.test(pathname) ? 10 : 0;
}

function shouldExpandIndex(
	raw: string,
	base: string,
	seen: Set<string>,
	urls: Set<string>,
	config: PipelineConfig,
) {
	const url = new URL(raw);
	return (
		url.origin === new URL(base).origin &&
		url.pathname.endsWith("/index.md") &&
		!seen.has(url.href) &&
		(!config.maxExplicit || urls.size < config.max)
	);
}
