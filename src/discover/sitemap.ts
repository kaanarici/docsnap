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
	const candidates = new Set<string>(scopedSitemapCandidates(base));
	for (const sitemap of sitemapUrls) candidates.add(sitemap);
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

function scopedSitemapCandidates(base: URL) {
	const path = base.pathname.replace(/\/$/, "");
	if (!path || path.includes(".")) return [];
	return [`${base.origin}${path}.sitemap.xml`];
}

async function readSitemap(
	url: string,
	config: Config,
	depth: number,
	found: Set<string>,
	options: Required<Pick<SitemapOptions, "limit" | "scope">> & SitemapOptions,
): Promise<"blocked" | "empty" | "found"> {
	const before = found.size;
	if (depth > 3 || found.size >= options.limit) return "empty";
	const response = await fetchText(
		url,
		config,
		"application/xml,text/xml,*/*;q=0.8",
	);
	if (!response.ok)
		return response.status === 403 || response.failureKind === "blocked"
			? "blocked"
			: "empty";
	if (!response.body.includes("<")) return "empty";
	const document = new DOMParser().parseFromString(response.body, "text/xml");
	const rawLocs = [...document.querySelectorAll("loc")]
		.map((element) => absoluteHttpUrl(element.textContent ?? "", url))
		.filter((value): value is string => Boolean(value));
	const locs = rawLocs
		.map((loc) => normalizeUrl(loc))
		.filter((value): value is string => Boolean(value));
	const sitemapLocs = rawLocs.filter(isSitemapUrl);
	const xmlLocs = rawLocs.filter(isXmlUrl);
	const pageLocs = locs.filter((loc) => !isXmlUrl(loc));
	const rootName = document.documentElement?.localName;
	const indexLocs = rootName === "sitemapindex" ? xmlLocs : sitemapLocs;
	const isIndex =
		rootName === "sitemapindex" ||
		(sitemapLocs.length > 0 && sitemapLocs.length === rawLocs.length);
	if (!isIndex) {
		for (const loc of locs) {
			if (found.size >= options.limit) break;
			if (!options.accept || options.accept(loc)) found.add(loc);
		}
		return found.size > before ? "found" : "empty";
	}
	if (rootName === "sitemapindex") {
		for (const loc of pageLocs) {
			if (found.size >= options.limit) return "found";
			if (!options.accept || options.accept(loc)) found.add(loc);
		}
		if (xmlLocs.length === 0) return found.size > before ? "found" : "empty";
	}

	const childSitemaps = prioritizedSitemaps(indexLocs, options.scope).slice(
		0,
		50,
	);
	const childConcurrency =
		options.limit <= 10 ? 1 : SITEMAP_INDEX_CHILD_CONCURRENCY;
	if (childConcurrency === 1) {
		let blocked = 0;
		for (const child of childSitemaps) {
			const result = await readSitemap(
				child,
				config,
				depth + 1,
				found,
				options,
			);
			if (found.size >= options.limit) return "found";
			blocked = result === "blocked" ? blocked + 1 : 0;
			if (blocked >= 5) break;
		}
		return found.size > before ? "found" : "empty";
	}
	let nextChild = 0;
	const workers = Array.from(
		{ length: Math.min(childConcurrency, childSitemaps.length) },
		async () => {
			while (found.size < options.limit) {
				const child = childSitemaps[nextChild++];
				if (!child) return;
				await readSitemap(child, config, depth + 1, found, options);
			}
		},
	);
	await Promise.all(workers);
	return found.size > before ? "found" : "empty";
}

function prioritizedSitemaps(locs: string[], scope: string) {
	const ordered = [...locs].sort(
		(a, b) => sitemapRank(b, scope) - sitemapRank(a, scope),
	);
	if (scope === "/") return ordered;
	const scoped = locs.filter((loc) =>
		pathInScope(new URL(loc).pathname, scope),
	);
	if (scoped.length > 0) {
		const scopedSet = new Set(scoped);
		return [
			...scoped.sort((a, b) => sitemapRank(b, scope) - sitemapRank(a, scope)),
			...ordered.filter((loc) => !scopedSet.has(loc)),
		];
	}
	return ordered;
}

function sitemapRank(raw: string, scope: string) {
	return sitemapHintScore(raw, scope) * 10_000 + sitemapPartNumber(raw);
}

function sitemapHintScore(raw: string, scope: string) {
	const pathname = new URL(raw).pathname.toLowerCase();
	return scope
		.split("/")
		.filter((part) => part.length > 2)
		.reduce((score, part) => {
			const variants = scopePartVariants(part);
			return score + Number(variants.some((variant) => variant.test(pathname)));
		}, 0);
}

function scopePartVariants(part: string) {
	const escaped = part.toLowerCase().replaceAll("-", "[_-]");
	const variants = [escaped];
	const locale = part.toLowerCase().match(/^([a-z]{2})-([a-z]{2})$/);
	if (locale) variants.push(`${locale[2]}[_-]${locale[1]}`);
	return variants.map(
		(variant) => new RegExp(`(?:^|[/_.-])${variant}(?:[/_.-]|$)`),
	);
}

function sitemapPartNumber(raw: string) {
	return Number(
		new URL(raw).pathname.match(/(?:^|\/|[_-])(\d+)\.xml$/i)?.[1] ?? 0,
	);
}

function isSitemapUrl(raw: string) {
	return /(?:^|\/)sitemap[^/]*\.xml$/i.test(new URL(raw).pathname);
}

function isXmlUrl(raw: string) {
	return /\.xml$/i.test(new URL(raw).pathname);
}

function absoluteHttpUrl(raw: string, base: string) {
	try {
		const url = new URL(raw, base);
		if (!["http:", "https:"].includes(url.protocol)) return;
		url.hash = "";
		return url.href;
	} catch {
		return;
	}
}

function seedScope(raw: string) {
	const url = new URL(raw);
	const parts = url.pathname.split("/").filter(Boolean);
	return parts.length > 0 ? `/${parts[0]}/` : "/";
}
