import { markdownLinkHrefs } from "../core/markdown.ts";
import type { DiscoveredUrl, DiscoverySource } from "../core/types.ts";
import { dropFragmentAndQuery } from "../core/url.ts";

export const ignoredExtension =
	/\.(png|jpe?g|gif|svg|webp|ico|pdf|epub|zip|tar|gz|mp4|mp3|wav|woff2?|ttf|eot|css|js|mjs|map|rss|atom)$/i;

export function normalizeUrl(
	raw: string,
	base?: string | URL,
): string | undefined {
	try {
		const url = new URL(raw, base);
		if (!["http:", "https:"].includes(url.protocol)) return;
		dropFragmentAndQuery(url);
		url.pathname = url.pathname.replace(/\/{2,}/g, "/");
		collapseRepeatedBasePath(url, base);
		if (!url.pathname) url.pathname = "/";
		if (isNonPageUrl(url)) return;
		return url.href;
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
	return parts.length <= 1 ? url.pathname : `/${parts.slice(0, -1).join("/")}/`;
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
	if (scope.endsWith("/")) return pathname.startsWith(scope);
	return pathname === scope || pathname.startsWith(`${scope}/`);
}

export function addDiscovered(
	out: DiscoveredUrl[],
	seen: Set<string>,
	raw: string | undefined,
	source: DiscoverySource,
	seed: string,
	scope: string,
	fetched?: DiscoveredUrl["fetched"],
): void {
	if (!raw || seen.has(raw) || !inScope(raw, seed, scope)) return;
	seen.add(raw);
	out.push({ url: raw, source, ...(fetched ? { fetched } : {}) });
}

export function sameScopeLinks(markdown: string, base: string): string[] {
	const links = new Set<string>();
	for (const href of markdownLinkHrefs(markdown)) {
		const url = normalizeUrl(href, base);
		if (url) links.add(url);
	}
	for (const match of markdown.matchAll(/https?:\/\/[^\s<>"'`)]+/g)) {
		const url = normalizeUrl(cleanTextLink(match[0]), base);
		if (url) links.add(url);
	}
	for (const match of markdown.matchAll(/(^|\s)(\/[a-z0-9][^\s<>"'`)]+)/gi)) {
		const url = normalizeUrl(cleanTextLink(match[2]!), base);
		if (url) links.add(url);
	}
	return [...links];
}

function cleanTextLink(value: string) {
	return value.replace(/[.,;:!?]+$/g, "");
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
		/(?:^|\/)(?:copyright|copying(?:_[a-z]+)?)\.html$/i.test(url.pathname) ||
		/(?:^|\/)page\/index\.md$/i.test(url.pathname) ||
		/\.x?html?\.md$/i.test(url.pathname) ||
		/(?:^|\/)api\/(?:article|search)(?:\/|$)/i.test(url.pathname) ||
		/youtube\.com\/watch/i.test(url.pathname) ||
		/(?:^|\/)(?:rss|feed|atom)\.xml$/i.test(url.pathname) ||
		/(?:^|\/)(?:chat|demo|playground|repl|test)\/?$/i.test(url.pathname) ||
		/\/chunked\/.*\.json$/i.test(url.pathname) ||
		/(?:^|\/)(?:robots\.txt|sitemap[^/]*\.xml)$/i.test(url.pathname)
	);
}
