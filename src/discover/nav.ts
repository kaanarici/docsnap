import { parseHTML } from "linkedom";
import { normalizeUrl } from "./url.ts";

const selectors = [
	"nav a[href]",
	"aside a[href]",
	'[class*="sidebar" i] a[href]',
	'[class*="navigation" i] a[href]',
	'[class*="toc" i] a[href]',
	'[role="navigation"] a[href]',
];

export function discoverNav(html: string, base: string): string[] {
	return discoverLinks(html, base, selectors);
}

export function discoverPageLinks(html: string, base: string): string[] {
	return discoverLinks(html, base, ["a[href]"]);
}

function discoverLinks(html: string, base: string, linkSelectors: string[]) {
	const { document } = parseHTML(html);
	const urls = new Set<string>();
	for (const selector of linkSelectors) {
		for (const link of document.querySelectorAll(selector)) {
			const href = link.getAttribute("href");
			const url = href ? normalizeUrl(href, base) : undefined;
			if (url) urls.add(url);
		}
	}
	return [...urls];
}
