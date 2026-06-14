import { DOMParser, parseHTML } from "linkedom";
import type { Config, DiscoveredUrl, FetchResult } from "../core/types.ts";
import { type FetchUrlGate, fetchText } from "../fetch/fetcher.ts";
import { discoverPageLinks } from "./nav.ts";
import {
	addDiscovered,
	inScope,
	normalizeDiscoveryResourceUrl,
	normalizeUrl,
	pathInScope,
} from "./url.ts";

export type FeedEntry = {
	url: string;
	publishedAt?: string;
	updatedAt?: string;
};

type FeedDiscoveryOptions = {
	limit?: number;
	accept?: (url: string) => boolean;
	allowResource?: FetchUrlGate | undefined;
	response?: FetchResult;
};

type RelNextOptions = {
	limit?: number;
	accept?: (url: string) => boolean;
	allowResource?: FetchUrlGate | undefined;
};

const FEED_ACCEPT =
	"application/rss+xml,application/atom+xml,application/xml,text/xml,*/*;q=0.8";
const REL_NEXT_MAX_PAGES = 3;

export function discoverFeedLinks(html: string, base: string): string[] {
	const { document } = parseHTML(html);
	const urls = new Set<string>();
	for (const link of document.querySelectorAll("link[rel][href]")) {
		if (!relTokens(link).includes("alternate")) continue;
		if (!feedType(link.getAttribute("type"))) continue;
		const href = link.getAttribute("href");
		const url = href ? normalizeDiscoveryResourceUrl(href, base) : undefined;
		if (url) urls.add(url);
	}
	return [...urls];
}

export function parseFeedEntries(xml: string, base: string): FeedEntry[] {
	try {
		const document = new DOMParser().parseFromString(xml, "text/xml");
		const root = document.documentElement as unknown as Element | null;
		if (!root) return [];
		const rootName = localName(root);
		const entries =
			rootName === "feed"
				? atomEntries(root, base)
				: rootName === "rss" || rootName === "rdf"
					? rssEntries(root, base)
					: [];
		return newestFirst(entries);
	} catch {
		return [];
	}
}

export function isFeedResponse(response: FetchResult): boolean {
	return isFeedContent(response.contentType, response.body);
}

export async function discoverFeed(
	feedUrl: string,
	seed: string,
	scope: string,
	config: Config,
	options: FeedDiscoveryOptions = {},
): Promise<DiscoveredUrl[]> {
	const limit = options.limit ?? Number.POSITIVE_INFINITY;
	if (limit <= 0) return [];
	const resourceUrl = normalizeDiscoveryResourceUrl(feedUrl) ?? feedUrl;
	if (options.allowResource && !(await options.allowResource(resourceUrl)))
		return [];
	const response =
		options.response ??
		(await fetchText(
			resourceUrl,
			config,
			FEED_ACCEPT,
			undefined,
			options.allowResource,
		));
	if (!response.ok || !isFeedResponse(response)) return [];
	if (
		options.allowResource &&
		response.finalUrl !== resourceUrl &&
		!(await options.allowResource(response.finalUrl))
	)
		return [];
	return feedEntriesToDiscovered(
		parseFeedEntries(response.body, response.finalUrl),
		seed,
		scope,
		limit,
		options.accept,
	);
}

export async function discoverRelNextPages(
	html: string,
	base: string,
	seed: string,
	scope: string,
	config: Config,
	options: RelNextOptions = {},
): Promise<DiscoveredUrl[]> {
	const limit = options.limit ?? Number.POSITIVE_INFINITY;
	if (limit <= 0) return [];
	const out: DiscoveredUrl[] = [];
	const seen = new Set<string>();
	const fetched = new Set([normalizeDiscoveryResourceUrl(base) ?? base]);
	let next = discoverRelNext(html, base);
	for (
		let page = 0;
		page < REL_NEXT_MAX_PAGES && next && out.length < limit;
		page++
	) {
		if (fetched.has(next) || !resourceInScope(next, seed, scope)) break;
		if (options.allowResource && !(await options.allowResource(next))) break;
		fetched.add(next);
		const response = await fetchText(
			next,
			config,
			undefined,
			undefined,
			options.allowResource,
		);
		if (!response.ok || !resourceInScope(response.finalUrl, seed, scope)) break;
		if (
			options.allowResource &&
			response.finalUrl !== next &&
			!(await options.allowResource(response.finalUrl))
		)
			break;
		for (const link of discoverPageLinks(response.body, response.finalUrl)) {
			if (!options.accept || options.accept(link)) {
				addDiscovered(out, seen, link, "crawl", seed, scope);
			}
			if (out.length >= limit) break;
		}
		next = discoverRelNext(response.body, response.finalUrl);
	}
	return out;
}

function feedEntriesToDiscovered(
	entries: FeedEntry[],
	seed: string,
	scope: string,
	limit: number,
	accept: ((url: string) => boolean) | undefined,
) {
	const out: DiscoveredUrl[] = [];
	const seen = new Set<string>();
	for (const entry of entries) {
		if (!inScope(entry.url, seed, scope)) continue;
		if (accept && !accept(entry.url)) continue;
		const { url, ...metadata } = entry;
		addDiscovered(out, seen, url, "feed", seed, scope, undefined, metadata);
		if (out.length >= limit) break;
	}
	return out;
}

function rssEntries(root: Element, base: string): FeedEntry[] {
	const channels = childElements(root, "channel");
	const containers = channels.length > 0 ? channels : [root];
	return containers.flatMap((channel) =>
		childElements(channel, "item").flatMap((item) => {
			const url = entryUrl(childText(item, "link"), base);
			return url
				? [
						{
							url,
							...dateField(
								"publishedAt",
								childText(item, "pubdate") ?? childText(item, "date"),
							),
						},
					]
				: [];
		}),
	);
}

function atomEntries(root: Element, base: string): FeedEntry[] {
	return childElements(root, "entry").flatMap((entry) => {
		const url = atomLink(entry, base);
		return url
			? [
					{
						url,
						...dateField("publishedAt", childText(entry, "published")),
						...dateField("updatedAt", childText(entry, "updated")),
					},
				]
			: [];
	});
}

function atomLink(entry: Element, base: string) {
	const links = childElements(entry, "link");
	const preferred =
		links.find((link) => {
			const rel = link.getAttribute("rel")?.toLowerCase();
			return (!rel || rel === "alternate") && link.getAttribute("href");
		}) ?? links.find((link) => link.getAttribute("href"));
	const href = preferred?.getAttribute("href");
	return entryUrl(href ?? undefined, base);
}

function newestFirst(entries: FeedEntry[]) {
	return entries
		.map((entry, index) => ({ entry, index, time: entryTime(entry) }))
		.sort((a, b) => {
			if (Number.isFinite(a.time) && Number.isFinite(b.time))
				return b.time - a.time || a.index - b.index;
			if (Number.isFinite(a.time)) return -1;
			if (Number.isFinite(b.time)) return 1;
			return a.index - b.index;
		})
		.map(({ entry }) => entry);
}

function entryTime(entry: FeedEntry) {
	return Date.parse(entry.publishedAt ?? entry.updatedAt ?? "");
}

function dateField(
	key: "publishedAt" | "updatedAt",
	value: string | undefined,
) {
	const iso = isoDate(value);
	return iso ? { [key]: iso } : {};
}

function isoDate(value: string | undefined) {
	if (!value) return;
	const time = Date.parse(value.trim());
	return Number.isFinite(time) ? new Date(time).toISOString() : undefined;
}

function childText(element: Element, name: string) {
	return childElements(element, name)[0]?.textContent?.trim();
}

function childElements(element: Element, name: string) {
	return Array.from(element.children).filter(
		(child) => localName(child) === name,
	);
}

function localName(element: Element | null | undefined) {
	// linkedom returns the prefixed name (e.g. "rdf:RDF") for namespaced
	// elements; drop the prefix so RSS 1.0/RDF feeds match feed/rss/rdf
	return (element?.localName ?? "").toLowerCase().split(":").pop() ?? "";
}

function isFeedContent(contentType: string, body: string) {
	const type = contentType.toLowerCase().split(";")[0]?.trim() ?? "";
	if (type === "application/rss+xml" || type === "application/atom+xml")
		return true;
	try {
		const document = new DOMParser().parseFromString(body, "text/xml");
		const root = document.documentElement as unknown as Element | null;
		return ["feed", "rss", "rdf"].includes(localName(root));
	} catch {
		return false;
	}
}

function entryUrl(raw: string | undefined, base: string) {
	const value = raw?.trim();
	return value ? normalizeUrl(value, base) : undefined;
}

function feedType(value: string | null) {
	const type = value?.toLowerCase().split(";")[0]?.trim();
	return type === "application/rss+xml" || type === "application/atom+xml";
}

function discoverRelNext(html: string, base: string) {
	const { document } = parseHTML(html);
	for (const link of document.querySelectorAll("link[rel][href]")) {
		if (!relTokens(link).includes("next")) continue;
		const href = link.getAttribute("href");
		const url = href ? normalizeDiscoveryResourceUrl(href, base) : undefined;
		if (url) return url;
	}
	return undefined;
}

function relTokens(element: Element) {
	return (element.getAttribute("rel") ?? "")
		.toLowerCase()
		.split(/\s+/)
		.filter(Boolean);
}

function resourceInScope(raw: string, seed: string, scope: string) {
	try {
		const url = new URL(raw);
		const base = new URL(seed);
		return url.origin === base.origin && pathInScope(url.pathname, scope);
	} catch {
		return false;
	}
}
