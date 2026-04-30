import { DOMParser } from "linkedom";
import type { Config } from "../core/types.ts";
import { fetchText } from "../fetch/fetcher.ts";
import { normalizeUrl, pathInScope } from "./url.ts";

type SitemapOptions = {
	limit?: number;
	accept?: (url: string) => boolean;
	scope?: string;
};

const SITEMAP_INDEX_CHILD_CONCURRENCY = 4;

export async function discoverSitemaps(
	seed: string,
	sitemapUrls: string[],
	config: Config,
	options: SitemapOptions = {},
): Promise<string[]> {
	const limit = options.limit ?? Number.POSITIVE_INFINITY;
	if (limit <= 0) return [];

	const base = new URL(seed);
	const candidates = new Set<string>(sitemapUrls);
	for (const path of [
		"/sitemap.xml",
		"/sitemap_index.xml",
		"/sitemap-index.xml",
		"/sitemap-0.xml",
	]) {
		candidates.add(`${base.origin}${path}`);
	}

	const found = new Set<string>();
	const scope = options.scope ?? seedScope(seed);
	for (const sitemap of candidates) {
		if (found.size >= limit) break;
		await readSitemap(sitemap, config, 0, found, {
			...options,
			limit,
			scope,
		});
	}
	return [...found];
}

async function readSitemap(
	url: string,
	config: Config,
	depth: number,
	found: Set<string>,
	options: Required<Pick<SitemapOptions, "limit" | "scope">> & SitemapOptions,
) {
	if (depth > 3 || found.size >= options.limit) return;
	const response = await fetchText(
		url,
		config,
		"application/xml,text/xml,*/*;q=0.8",
	);
	if (!response.ok || !response.body.includes("<")) return;
	const document = new DOMParser().parseFromString(response.body, "text/xml");
	const locs = [...document.querySelectorAll("loc")]
		.map((element) => normalizeUrl(element.textContent ?? "", url))
		.filter((value): value is string => Boolean(value));
	const isIndex = document.documentElement?.localName === "sitemapindex";
	if (!isIndex) {
		for (const loc of locs) {
			if (found.size >= options.limit) break;
			if (!options.accept || options.accept(loc)) found.add(loc);
		}
		return;
	}

	const childSitemaps = prioritizedSitemaps(locs, options.scope).slice(0, 50);
	let nextChild = 0;
	const workers = Array.from(
		{ length: Math.min(SITEMAP_INDEX_CHILD_CONCURRENCY, childSitemaps.length) },
		async () => {
			while (found.size < options.limit) {
				const child = childSitemaps[nextChild++];
				if (!child) return;
				await readSitemap(child, config, depth + 1, found, options);
			}
		},
	);
	await Promise.all(workers);
}

function prioritizedSitemaps(locs: string[], scope: string) {
	if (scope === "/") return locs;
	const scoped = locs.filter((loc) =>
		pathInScope(new URL(loc).pathname, scope),
	);
	if (scoped.length > 0) {
		const scopedSet = new Set(scoped);
		return [...scoped, ...locs.filter((loc) => !scopedSet.has(loc))];
	}
	return locs;
}

function seedScope(raw: string) {
	const url = new URL(raw);
	const parts = url.pathname.split("/").filter(Boolean);
	return parts.length > 0 ? `/${parts[0]}/` : "/";
}
