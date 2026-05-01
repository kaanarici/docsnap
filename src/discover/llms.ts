import { markdownLinkHrefs } from "../core/markdown.ts";
import type { Config } from "../core/types.ts";
import { fetchText } from "../fetch/fetcher.ts";
import { normalizeUrl, pathInScope, sameScopeLinks } from "./url.ts";

const CORPUS_INDEX_LIMIT = 256;

export async function discoverLlms(
	seed: string,
	config: Config,
): Promise<string[]> {
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

	const urls = new Set<string>();
	const seen = new Set<string>();
	const queue = [...paths].map((path) => `${base.origin}${path}`);
	const roots = new Set(queue);
	while (
		queue.length > 0 &&
		seen.size < CORPUS_INDEX_LIMIT &&
		(!config.maxExplicit || urls.size < config.max)
	) {
		const llmsUrl = queue.shift()!;
		if (seen.has(llmsUrl)) continue;
		seen.add(llmsUrl);
		const response = await fetchText(
			llmsUrl,
			config,
			"text/markdown,text/plain,*/*;q=0.8",
		);
		if (!response.ok || !isLlmsCorpus(response.contentType, response.body))
			continue;
		if (roots.has(llmsUrl)) urls.add(llmsUrl);
		for (const link of corpusLinks(
			response.body,
			llmsUrl,
			config.maxExplicit,
		)) {
			if (new URL(link).pathname === "/") continue;
			if (shouldExpandIndex(link, llmsUrl, seen, urls, config)) {
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
		/\[[^\]]+]\(([^)\s]+)[^)]*\)/.test(body) ||
		/(^|\n)\s*#\s+\S/m.test(body) ||
		/(^|\n)\s*[-*]\s+\S/m.test(body) ||
		/(^|\n)\s*https?:\/\/\S+/m.test(body) ||
		/(^|\n)\s*\/[^\s]+/m.test(body) ||
		/\bllms-(full|ctx|ctx-full)\.txt\b/i.test(body)
	);
}

function discoverCorpusHints(body: string, base: string, explicit: string[]) {
	const hints: string[] = [];
	for (const name of ["llms-full.txt", "llms-ctx.txt", "llms-ctx-full.txt"]) {
		if (explicit.some((raw) => new URL(raw).pathname.endsWith(`/${name}`)))
			continue;
		const url = normalizeUrl(name, base);
		if (url && body.includes(name)) hints.push(url);
	}
	return hints;
}

function corpusLinks(body: string, base: string, maxExplicit: boolean) {
	const explicit = corpusEntryLinks(body, base);
	const links = [
		...new Set([...explicit, ...discoverCorpusHints(body, base, explicit)]),
	];
	if (!maxExplicit) return links;
	return links.sort((a, b) => linkRank(a, base) - linkRank(b, base));
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

function linkRank(raw: string, base: string) {
	const scope = base.replace(/\/[^/]*$/, "/");
	const url = new URL(raw);
	return (
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
	config: Config,
) {
	const url = new URL(raw);
	return (
		url.origin === new URL(base).origin &&
		url.pathname.endsWith("/index.md") &&
		!seen.has(url.href) &&
		(!config.maxExplicit || urls.size < config.max)
	);
}
