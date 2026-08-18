import { maxGeneratedCapturePages } from "../core/config.ts";
import { escapeRegExp } from "../core/text.ts";
import type { PipelineConfig } from "../core/types.ts";
import { type FetchUrlGate, fetchText } from "../fetch/fetcher.ts";
import { normalizeUrl, pathInScope } from "./url.ts";

type SitemapOptions = {
	limit?: number;
	accept?: (url: string) => boolean;
	scope?: string;
	allowResource?: FetchUrlGate | undefined;
};
type SitemapStatus = {
	truncated: boolean;
	resources: number;
	deadline: number;
};
const maxSitemapLocations = 10_000;

export async function discoverSitemaps(
	seed: string,
	sitemapUrls: string[],
	config: PipelineConfig,
	options: SitemapOptions = {},
): Promise<{ urls: string[]; truncated: boolean }> {
	const limit = options.limit ?? Number.POSITIVE_INFINITY;
	if (limit <= 0) return { urls: [], truncated: false };

	const base = new URL(seed);
	const status: SitemapStatus = {
		truncated: false,
		resources: 0,
		deadline: performance.now() + Math.min(config.timeoutMs, 3_000),
	};
	const candidates = new Set<string>();
	const addCandidate = (raw: string) => {
		const url = absoluteHttpUrl(raw, base.href);
		if (url && new URL(url).origin === base.origin) candidates.add(url);
	};
	for (const sitemap of scopedSitemapCandidates(base)) addCandidate(sitemap);
	for (const sitemap of sitemapUrls) addCandidate(sitemap);
	for (const path of [
		"/sitemap.xml",
		"/sitemap_index.xml",
		"/sitemap-index.xml",
		"/sitemap-0.xml",
	]) {
		addCandidate(`${base.origin}${path}`);
	}

	const found = new Set<string>();
	const scope = options.scope ?? seedScope(seed);
	for (const sitemap of candidates) {
		if (found.size >= limit) break;
		await readSitemap(sitemap, config, 0, found, {
			...options,
			limit,
			origin: base.origin,
			scope,
			status,
		});
	}
	return { urls: [...found], truncated: status.truncated };
}

function scopedSitemapCandidates(base: URL) {
	const path = base.pathname.replace(/\/$/, "");
	if (!path || path.includes(".")) return [];
	return [`${base.origin}${path}.sitemap.xml`];
}

async function readSitemap(
	url: string,
	config: PipelineConfig,
	depth: number,
	found: Set<string>,
	options: Required<Pick<SitemapOptions, "limit" | "scope">> &
		SitemapOptions & { origin: string; status: SitemapStatus },
): Promise<void> {
	if (found.size >= options.limit) return;
	if (depth > 3 || options.status.resources >= maxGeneratedCapturePages) {
		options.status.truncated = true;
		return;
	}
	options.status.resources++;
	if (options.allowResource && !(await options.allowResource(url))) return;
	const remaining = Math.ceil(options.status.deadline - performance.now());
	if (remaining <= 0) {
		options.status.truncated = true;
		return;
	}
	const signal = AbortSignal.timeout(remaining);
	const response = await fetchText(
		url,
		config,
		"application/xml,text/xml,*/*;q=0.8",
		undefined,
		options.allowResource,
		{ signal },
	);
	options.status.truncated ||= signal.aborted;
	if (!response.ok || new URL(response.finalUrl).origin !== options.origin)
		return;
	if (!response.body.includes("<")) return;
	const locations = sitemapLocs(response.body);
	options.status.truncated ||= locations.truncated;
	const rawLocs = locations.urls
		.map((raw) => absoluteHttpUrl(raw, url))
		.filter((value): value is string => Boolean(value));
	const xmlLocs: string[] = [];
	const pageLocs: string[] = [];
	for (const loc of rawLocs) {
		if (new URL(loc).origin !== options.origin) continue;
		if (isXmlUrl(loc)) xmlLocs.push(loc);
		else {
			const page = normalizeUrl(loc);
			if (page) pageLocs.push(page);
		}
	}
	const nested = xmlLocs.filter(isSitemapUrl);
	const rootName = response.body
		.match(/<\s*(sitemapindex|urlset)\b/i)?.[1]
		?.toLowerCase();
	const indexLocs = rootName === "sitemapindex" ? xmlLocs : nested;
	const isIndex =
		rootName === "sitemapindex" ||
		(nested.length > 0 && nested.length === rawLocs.length);
	if (!isIndex || rootName === "sitemapindex") {
		for (const loc of pageLocs) {
			if (found.size >= options.limit) return;
			if (!options.accept || options.accept(loc)) found.add(loc);
		}
		if (!isIndex || xmlLocs.length === 0) return;
	}

	const children = prioritizedSitemaps(indexLocs, options.scope);
	const childLimit = Math.min(children.length, 50);
	if (childLimit < children.length) options.status.truncated = true;
	const selected = children.slice(0, childLimit);
	const concurrency = Math.max(
		1,
		Math.min(4, config.concurrency, config.perOrigin),
	);
	for (
		let offset = 0;
		offset < selected.length && found.size < options.limit;
		offset += concurrency
	) {
		const remaining = options.limit - found.size;
		const batches = await Promise.all(
			selected.slice(offset, offset + concurrency).map(async (child) => {
				const pages = new Set<string>();
				await readSitemap(child, config, depth + 1, pages, {
					...options,
					limit: remaining,
				});
				return pages;
			}),
		);
		for (const pages of batches) {
			for (const page of pages) {
				if (found.size >= options.limit) break;
				found.add(page);
			}
		}
	}
}

function prioritizedSitemaps(locs: string[], scope: string) {
	const hints = scope
		.split("/")
		.filter((part) => part.length > 2)
		.map(scopePartVariants);
	const ranks = new Map<string, number>();
	for (const raw of locs) {
		const pathname = new URL(raw).pathname.toLowerCase();
		const score = hints.reduce(
			(total, variants) =>
				total + Number(variants.some((variant) => variant.test(pathname))),
			0,
		);
		ranks.set(raw, score * 10_000 + sitemapPartNumber(pathname));
	}
	const ordered = [...locs].sort(
		(a, b) => (ranks.get(b) ?? 0) - (ranks.get(a) ?? 0),
	);
	if (scope === "/") return ordered;
	const scoped = ordered.filter((loc) =>
		pathInScope(new URL(loc).pathname, scope),
	);
	if (scoped.length > 0) {
		const scopedSet = new Set(scoped);
		return [...scoped, ...ordered.filter((loc) => !scopedSet.has(loc))];
	}
	return ordered;
}

function sitemapPartNumber(pathname: string) {
	return Number(pathname.match(/(?:^|\/|[_-])(\d+)\.xml$/i)?.[1] ?? 0);
}
function scopePartVariants(part: string) {
	const lower = part.toLowerCase();
	// Bound and escape the seed-derived segment before building a RegExp.
	if (lower.length > 64) return [];
	const escaped = escapeRegExp(lower).replaceAll("-", "[_-]");
	const variants = [escaped];
	const locale = lower.match(/^([a-z]{2})-([a-z]{2})$/);
	if (locale) variants.push(`${locale[2]}[_-]${locale[1]}`);
	return variants.map(
		(variant) => new RegExp(`(?:^|[/_.-])${variant}(?:[/_.-]|$)`),
	);
}

function isSitemapUrl(raw: string) {
	return /(?:^|\/)sitemap[^/]*\.xml$/i.test(new URL(raw).pathname);
}

function sitemapLocs(xml: string) {
	const locs: string[] = [];
	const open = /<loc(?:\s[^>]*)?>/gi;
	const close = /<\/loc\s*>/gi;
	for (let match = open.exec(xml); match; match = open.exec(xml)) {
		if (locs.length >= maxSitemapLocations) {
			return { urls: locs, truncated: true };
		}
		close.lastIndex = open.lastIndex;
		const end = close.exec(xml);
		if (!end) break;
		let value = xml.slice(open.lastIndex, end.index).trim();
		if (value.startsWith("<![CDATA[") && value.endsWith("]]>")) {
			value = value.slice(9, -3);
		}
		locs.push(decodeXml(value));
		open.lastIndex = close.lastIndex;
	}
	return { urls: locs, truncated: false };
}

function decodeXml(value: string) {
	return value.replace(
		/&(?:amp|lt|gt|quot|apos|#(\d+)|#x([0-9a-f]+));/gi,
		(entity, decimal: string | undefined, hex: string | undefined) => {
			if (decimal || hex) {
				const codePoint = Number.parseInt(
					decimal ?? hex ?? "",
					decimal ? 10 : 16,
				);
				return codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : entity;
			}
			return (
				{
					"&amp;": "&",
					"&lt;": "<",
					"&gt;": ">",
					"&quot;": '"',
					"&apos;": "'",
				}[entity.toLowerCase()] ?? entity
			);
		},
	);
}

function isXmlUrl(raw: string) {
	return /\.xml$/i.test(new URL(raw).pathname);
}

function absoluteHttpUrl(raw: string, base: string) {
	try {
		const url = new URL(raw, base);
		if (url.protocol !== "http:" && url.protocol !== "https:") return;
		if (url.username || url.password) return;
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
