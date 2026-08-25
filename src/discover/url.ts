import { markdownLinkHrefs } from "../core/markdown.ts";
import {
	type DiscoveredUrl,
	type DiscoverySource,
	discoverySourceScore,
} from "../core/types.ts";
import { canonicalUrlSearch, classifyDiscoveryResource } from "../core/url.ts";
import { maxPublicUrlChars } from "../security/url.ts";

export const ignoredExtension =
	/\.(png|jpe?g|gif|svg|webp|ico|pdf|epub|zip|tar|tgz|gz|bz2|xz|zst|7z|rar|mp4|mp3|wav|woff2?|ttf|eot|css|js|mjs|map|rss|atom)$/i;
const trackingParam =
	/^(?:_ga|dclid|fbclid|gclid|mc_(?:cid|eid)|msclkid|utm(?:_.+)?)$/i;

export function normalizeUrl(
	raw: string,
	base?: string | URL,
): string | undefined {
	const url = normalizedHttpUrl(raw, base);
	if (!url) return;
	const searchParamNames = Array.from(url.searchParams.keys());
	for (const name of searchParamNames) {
		if (trackingParam.test(name)) url.searchParams.delete(name);
	}
	url.search = canonicalUrlSearch(url);
	collapseRepeatedBasePath(url, base);
	if (isNonPageUrl(url)) return;
	return url.href.length <= maxPublicUrlChars ? url.href : undefined;
}

export function normalizeDiscoveryResourceUrl(
	raw: string,
	base?: string | URL,
): string | undefined {
	const url = normalizedHttpUrl(raw, base);
	if (!url) return;
	if (
		ignoredExtension.test(url.pathname) &&
		classifyDiscoveryResource(url)?.source !== "feed"
	) {
		return;
	}
	return url.href.length <= maxPublicUrlChars ? url.href : undefined;
}

function normalizedHttpUrl(raw: string, base?: string | URL) {
	try {
		const url = new URL(raw, base);
		if (url.protocol !== "http:" && url.protocol !== "https:") return;
		if (url.username || url.password) return;
		url.hash = "";
		url.pathname = url.pathname.replace(/\/{2,}/g, "/") || "/";
		return url;
	} catch {
		return;
	}
}

export function scopeFromSeed(seed: string): string {
	const url = new URL(seed);
	if (url.pathname === "/" || url.pathname === "") return "/";
	if (url.pathname.endsWith("/")) return url.pathname;
	if (/\.[a-z0-9]+$/i.test(url.pathname))
		return url.pathname.replace(/\/[^/]*$/, "/") || "/";
	const parts = url.pathname.split("/").filter(Boolean);
	return parts.length <= 2 ? url.pathname : `/${parts.slice(0, -1).join("/")}/`;
}

export function inScope(raw: string, seed: string, scope: string): boolean {
	const url = new URL(raw);
	const base = new URL(seed);
	return (
		url.origin === base.origin &&
		pathInScope(url.pathname, scope) &&
		!ignoredExtension.test(url.pathname)
	);
}

export function pathInScope(pathname: string, scope: string): boolean {
	if (scope === "/") return true;
	if (scope.endsWith("/")) {
		const sectionRoot = scope.slice(0, -1);
		const pageVariant = pagePathVariant(pathname);
		return (
			pathname === sectionRoot ||
			pathname.startsWith(scope) ||
			(pageVariant !== undefined && pageVariant === sectionRoot)
		);
	}
	return pathname === scope || pathname.startsWith(`${scope}/`);
}

export function chooseScope(inputScope: string, seed: string, links: string[]) {
	const seedPath = new URL(seed).pathname;
	const seedScope = scopeFromSeed(seed);
	const baseScope =
		inputScope !== "/" && pathInScope(seedPath, inputScope)
			? inputScope
			: seedScope;
	if (inputScope !== "/" && seedPath === inputScope.replace(/\/$/, "")) {
		return inputScope;
	}
	let best = baseScope;
	let bestCount = countInScope(links, seed, best);
	for (const scope of parentScopes(baseScope)) {
		if ((scope === "/" || isLocaleOnlyScope(scope)) && bestCount >= 3) continue;
		const count = countInScope(links, seed, scope);
		if (count > bestCount + 2) {
			best = scope;
			bestCount = count;
		}
	}
	return best;
}

function pagePathVariant(pathname: string) {
	const match = pathname.match(/\.(?:html?|mdx?|txt)$/i);
	return match ? pathname.slice(0, match.index) : undefined;
}

function countInScope(links: string[], seed: string, scope: string) {
	return links.filter((link) => inScope(link, seed, scope)).length;
}

function parentScopes(scope: string) {
	const parts = scope.split("/").filter(Boolean);
	const scopes: string[] = [];
	for (let i = parts.length - 1; i >= 1; i--) {
		scopes.push(`/${parts.slice(0, i).join("/")}/`);
	}
	scopes.push("/");
	return scopes;
}

function isLocaleOnlyScope(scope: string) {
	return /^\/[a-z]{2}(?:-[a-z]{2})?\/$/i.test(scope);
}

export function addDiscovered(
	out: DiscoveredUrl[],
	seen: Set<string>,
	raw: string | undefined,
	source: DiscoverySource,
	seed: string,
	scope: string,
	fetched?: DiscoveredUrl["fetched"],
	metadata?: DiscoveredUrl["metadata"],
): void {
	if (!raw || !inScope(raw, seed, scope)) return;
	if (seen.has(raw)) {
		const existing = out.find((item) => item.url === raw);
		if (existing) mergeDiscovered(existing, source, fetched, metadata);
		return;
	}
	seen.add(raw);
	const discovered: DiscoveredUrl = {
		url: raw,
		source,
	};
	if (source === "seed") discovered.wasSeed = true;
	if (fetched) discovered.fetched = fetched;
	if (metadata) discovered.metadata = metadata;
	out.push(discovered);
}

export function sameScopeLinks(
	markdown: string,
	base: string,
	limit?: number,
): string[] {
	const links = new Set<string>();
	if (limit !== undefined && limit <= 0) return [];
	for (const href of markdownLinkHrefs(markdown, limit)) {
		const url = normalizeUrl(href, base);
		if (url) links.add(url);
		if (limit !== undefined && links.size >= limit) return [...links];
	}
	for (const match of markdown.matchAll(/https?:\/\/[^\s<>"'`)]+/g)) {
		const url = normalizeUrl(cleanTextLink(match[0]), base);
		if (url) links.add(url);
		if (limit !== undefined && links.size >= limit) return [...links];
	}
	for (const match of markdown.matchAll(/(^|\s)(\/[a-z0-9][^\s<>"'`)]+)/gi)) {
		const url = normalizeUrl(cleanTextLink(match[2]!), base);
		if (url) links.add(url);
		if (limit !== undefined && links.size >= limit) return [...links];
	}
	return [...links];
}

function cleanTextLink(value: string) {
	return value.replace(/[.,;:!?\]]+$/g, "");
}

function collapseRepeatedBasePath(url: URL, base?: string | URL) {
	if (!base || !url.pathname.endsWith(".md")) return;
	const baseUrl = new URL(base);
	if (url.origin !== baseUrl.origin) return;
	const dir = baseUrl.pathname
		.replace(/\/[^/]*$/, "/")
		.split("/")
		.filter(Boolean);
	if (dir.length === 0) return;
	const parts = url.pathname.split("/").filter(Boolean);
	if (!dir.every((part, index) => parts[index] === part)) return;
	if (!dir.every((part, index) => parts[index + dir.length] === part)) return;
	url.pathname = `/${parts.slice(dir.length).join("/")}`;
}

function isNonPageUrl(url: URL) {
	return (
		/(?:%e2%80%a6|…)/i.test(url.href) ||
		[...url.searchParams.keys()].some((name) =>
			/^(?:post_)?login_(?:redirect|return)(?:_url)?$/i.test(name),
		) ||
		/%3c|%3e|[<>]/i.test(url.pathname) ||
		/%7b|%7d|[{}]/i.test(url.pathname) ||
		/(?:^|\/)(?:%3a|:)[^/]+/i.test(url.pathname) ||
		/(?:^|\/)search\/?$/i.test(url.pathname) ||
		/(?:^|\/)(?:genindex|search|py-modindex)\.html$/i.test(url.pathname) ||
		/\/(?:_sources|\+\+theme\+\+[^/]+)\//i.test(url.pathname) ||
		/(?:^|\/)(?:create-account|try)\/?$/i.test(url.pathname) ||
		/(?:^|\/)cgi-bin\//i.test(url.pathname) ||
		/\/\.well-known\/captcha\//i.test(url.pathname) ||
		/\/cdn-cgi\//i.test(url.pathname) ||
		/(?:^|\/)(?:login|sign-?in|sign-?up|signup|register)(?:\/|$)/i.test(
			url.pathname,
		) ||
		/(?:^|\/)(?:managewatches|mydocs)(?:\/|$)/i.test(url.pathname) ||
		/(?:^|\/)contributors\.txt$/i.test(url.pathname) ||
		/(?:^|\/)(?:copyright|copying(?:_[a-z]+)?)\.html$/i.test(url.pathname) ||
		/(?:^|\/)page\/index\.md$/i.test(url.pathname) ||
		/\.x?html?\.md$/i.test(url.pathname) ||
		/(?:^|\/)api\/(?:article|search)(?:\/|$)/i.test(url.pathname) ||
		/youtube\.com\/watch/i.test(url.pathname) ||
		/(?:^|\/)(?:rss|feed|atom)\.xml$/i.test(url.pathname) ||
		/(?:^|\/)(?:rss|feed|atom)\/?$/i.test(url.pathname) ||
		/(?:^|\/)(?:chat|demo|playground|repl|test)\/?$/i.test(url.pathname) ||
		/\/chunked\/.*\.json$/i.test(url.pathname) ||
		/(?:^|\/)(?:robots\.txt|sitemap[^/]*\.xml)$/i.test(url.pathname)
	);
}

function mergeDiscovered(
	target: DiscoveredUrl,
	source: DiscoverySource,
	fetched: DiscoveredUrl["fetched"],
	metadata: DiscoveredUrl["metadata"],
) {
	if (source === "seed") target.wasSeed = true;
	if (fetched && !target.fetched) target.fetched = fetched;
	if (
		target.source !== "seed" &&
		discoverySourceScore(source) > discoverySourceScore(target.source)
	)
		target.source = source;
	if (!metadata) return;
	target.metadata = {
		...metadata,
		...target.metadata,
	};
}
