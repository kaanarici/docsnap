import { markdownLinkHrefs } from "../core/markdown.ts";
import type { DiscoveredUrl, DiscoverySource } from "../core/types.ts";
import { dropFragmentAndQuery } from "../core/url.ts";

export const ignoredExtension =
	/\.(png|jpe?g|gif|svg|webp|ico|pdf|zip|tar|gz|mp4|mp3|wav|woff2?|ttf|eot|css|js|mjs|map|rss|atom)$/i;

export function normalizeUrl(
	raw: string,
	base?: string | URL,
): string | undefined {
	try {
		const url = new URL(raw, base);
		if (!["http:", "https:"].includes(url.protocol)) return;
		dropFragmentAndQuery(url);
		url.pathname = url.pathname.replace(/\/{2,}/g, "/");
		if (!url.pathname) url.pathname = "/";
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
		const url = normalizeUrl(match[0], base);
		if (url) links.add(url);
	}
	for (const match of markdown.matchAll(/(^|\s)(\/[a-z0-9][^\s<>"'`)]+)/gi)) {
		const url = normalizeUrl(match[2]!, base);
		if (url) links.add(url);
	}
	return [...links];
}
