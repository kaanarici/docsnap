import { DOMParser } from "linkedom";
import type {
	DiscoveredUrl,
	FetchResult,
	PipelineConfig,
} from "../core/types.ts";
import { type FetchUrlGate, fetchText } from "../fetch/fetcher.ts";
import {
	addDiscovered,
	inScope,
	normalizeDiscoveryResourceUrl,
	normalizeUrl,
} from "./url.ts";

type FeedEntry = {
	url: string;
	publishedAt?: string;
	updatedAt?: string;
};

type FeedElement = {
	localName: string;
	children: ArrayLike<FeedElement>;
	textContent: string | null;
	getAttribute(name: string): string | null;
};

type FeedDiscoveryOptions = {
	limit?: number;
	accept?: (url: string) => boolean;
	allowResource?: FetchUrlGate | undefined;
	response?: FetchResult;
};

type FeedDiscovery = { pages: DiscoveredUrl[]; truncated: boolean };

const FEED_ACCEPT =
	"application/rss+xml,application/atom+xml,application/xml,text/xml,*/*;q=0.8";
const maxFeedXmlChars = 2_000_000;

function parseFeedEntries(xml: string, base: string): FeedEntry[] {
	try {
		const document = new DOMParser().parseFromString(
			xml.slice(0, maxFeedXmlChars),
			"text/xml",
		);
		const root = document.documentElement;
		if (!root) return [];
		const rootName = localName(root);
		if (rootName !== "feed" && rootName !== "rss" && rootName !== "rdf")
			return [];
		const atom = rootName === "feed";
		const channels = atom ? [root] : childElements(root, "channel");
		const containers = channels.length > 0 ? channels : [root];
		const entries = containers.flatMap((container) =>
			childElements(container, atom ? "entry" : "item").flatMap((entry) => {
				const url = atom
					? atomLink(entry, base)
					: entryUrl(childText(entry, "link"), base);
				if (!url) return [];
				const feedEntry: FeedEntry = { url };
				const publishedAt = feedDate(
					childText(entry, atom ? "published" : "pubdate") ??
						(atom ? undefined : childText(entry, "date")),
				);
				if (publishedAt) feedEntry.publishedAt = publishedAt;
				if (atom) {
					const updatedAt = feedDate(childText(entry, "updated"));
					if (updatedAt) feedEntry.updatedAt = updatedAt;
				}
				return [feedEntry];
			}),
		);
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
	config: PipelineConfig,
	options: FeedDiscoveryOptions = {},
): Promise<FeedDiscovery> {
	const limit = options.limit ?? Number.POSITIVE_INFINITY;
	if (limit <= 0) return { pages: [], truncated: false };
	const resourceUrl = normalizeDiscoveryResourceUrl(feedUrl) ?? feedUrl;
	if (options.allowResource && !(await options.allowResource(resourceUrl)))
		return { pages: [], truncated: false };
	const response =
		options.response ??
		(await fetchText(
			resourceUrl,
			config,
			FEED_ACCEPT,
			undefined,
			options.allowResource,
		));
	if (!response.ok || !isFeedResponse(response))
		return { pages: [], truncated: false };
	if (
		options.allowResource &&
		response.finalUrl !== resourceUrl &&
		!(await options.allowResource(response.finalUrl))
	)
		return { pages: [], truncated: false };
	const entries = parseFeedEntries(response.body, response.finalUrl);
	const pages = feedEntriesToDiscovered(
		entries,
		seed,
		scope,
		limit,
		options.accept,
	);
	return {
		pages:
			pages.length > 0 || scope === "/"
				? pages
				: feedEntriesToDiscovered(entries, seed, "/", limit, options.accept),
		truncated: response.body.length > maxFeedXmlChars,
	};
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

function atomLink(entry: FeedElement, base: string) {
	const links = childElements(entry, "link");
	const preferred =
		links.find((link) => {
			const rel = link.getAttribute("rel")?.toLowerCase();
			return (!rel || rel === "alternate") && link.getAttribute("href");
		}) ?? links.find((link) => link.getAttribute("href"));
	const href = preferred?.getAttribute("href");
	return entryUrl(href, base);
}

function newestFirst(entries: FeedEntry[]) {
	return entries
		.map((entry, index) => ({
			entry,
			index,
			time: Date.parse(entry.publishedAt ?? entry.updatedAt ?? ""),
		}))
		.sort((a, b) => {
			if (Number.isFinite(a.time) && Number.isFinite(b.time))
				return b.time - a.time || a.index - b.index;
			if (Number.isFinite(a.time)) return -1;
			if (Number.isFinite(b.time)) return 1;
			return a.index - b.index;
		})
		.map(({ entry }) => entry);
}

function feedDate(value: string | undefined) {
	const time = Date.parse(value?.trim() ?? "");
	return Number.isFinite(time) ? new Date(time).toISOString() : undefined;
}

function childText(element: FeedElement, name: string) {
	return childElements(element, name)[0]?.textContent?.trim();
}

function childElements(element: FeedElement, name: string) {
	return Array.from(element.children).filter(
		(child) => localName(child) === name,
	);
}

function localName(element: FeedElement | null | undefined) {
	return element?.localName.toLowerCase().split(":").pop() ?? "";
}

function isFeedContent(contentType: string, body: string) {
	const type = contentType.toLowerCase().split(";")[0]?.trim() ?? "";
	if (type === "application/rss+xml" || type === "application/atom+xml")
		return true;
	const root = body
		.slice(0, 4096)
		.match(/<(?:[a-z][\w.-]*:)?(feed|rss|rdf)\b/i)?.[1];
	return root !== undefined;
}

function entryUrl(raw: string | null | undefined, base: string) {
	const value = raw?.trim();
	return value ? normalizeUrl(value, base) : undefined;
}
