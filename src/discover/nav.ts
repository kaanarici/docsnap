import { parseHTML } from "linkedom";
import { maxGeneratedCapturePages } from "../core/config.ts";
import type { FetchResult } from "../core/types.ts";
import {
	normalizeDiscoveryResourceUrl,
	normalizeUrl,
	sameScopeLinks,
} from "./url.ts";

const selectors = [
	"nav a[href]",
	"aside a[href]",
	'[class*="sidebar" i] a[href]',
	'[class*="navigation" i] a[href]',
	'[class*="toc" i] a[href]',
	'[role="navigation"] a[href]',
];
const maxDiscoveryHtmlChars = 1_000_000;

export type PageResources = {
	links: string[];
	next?: string;
	nav?: string[];
	truncated?: boolean;
};

export function discoverPageResources(
	html: string,
	base: string,
	seed = false,
	parsedDocument?: Document,
): PageResources {
	const truncated = !parsedDocument && html.length > maxDiscoveryHtmlChars;
	const source = truncated ? html.slice(0, maxDiscoveryHtmlChars) : html;
	const document = parsedDocument ?? parseHTML(source).document;
	const links = new Set<string>();
	for (const link of document.querySelectorAll("a[href]")) {
		if (links.size >= maxGeneratedCapturePages) break;
		if (isControlLink(link)) continue;
		const url = normalizeUrl(link.getAttribute("href") ?? "", base);
		if (url) links.add(url);
	}
	let next: string | undefined;
	for (const link of document.querySelectorAll("link[rel][href]")) {
		const rel = relTokens(link);
		const href = link.getAttribute("href");
		const url = href ? normalizeDiscoveryResourceUrl(href, base) : undefined;
		if (!next && rel.includes("next")) next = url;
	}
	const resources: PageResources = { links: [...links] };
	if (next) resources.next = next;
	if (seed) resources.nav = discoverLinks(document, base);
	if (truncated) resources.truncated = true;
	return resources;
}

export function discoverFetchedResources(
	result: FetchResult,
	parsedDocument?: Document,
): PageResources {
	if (isHtmlResponse(result)) {
		return discoverPageResources(
			result.body,
			result.finalUrl,
			false,
			parsedDocument,
		);
	}
	if (
		result.ok &&
		(/(?:markdown|text\/plain)/i.test(result.contentType) ||
			/\.mdx?$/i.test(new URL(result.finalUrl).pathname))
	) {
		return {
			links: sameScopeLinks(
				result.body,
				result.finalUrl,
				maxGeneratedCapturePages,
			),
		};
	}
	return { links: [] };
}

export function isHtmlResponse(result: FetchResult) {
	return (
		result.ok &&
		(/html|xhtml/i.test(result.contentType) ||
			/<(?:html|body|main|article|a)\b/i.test(result.body.slice(0, 4096)))
	);
}

function discoverLinks(document: Document, base: string) {
	const urls = new Set<string>();
	for (const selector of selectors) {
		for (const link of document.querySelectorAll(selector)) {
			if (isControlLink(link)) continue;
			const href = link.getAttribute("href");
			const url = href ? normalizeUrl(href, base) : undefined;
			if (url) urls.add(url);
			if (urls.size >= maxGeneratedCapturePages) return [...urls];
		}
	}
	return [...urls];
}

function relTokens(element: Element) {
	return (element.getAttribute("rel") ?? "")
		.toLowerCase()
		.split(/\s+/)
		.filter(Boolean);
}

function isControlLink(link: Pick<Element, "getAttribute" | "hasAttribute">) {
	const toggle =
		link.getAttribute("data-bs-toggle") ?? link.getAttribute("data-toggle");
	if (toggle?.toLowerCase() === "dropdown") return true;
	return (
		(link.getAttribute("class") ?? "")
			.split(/\s+/)
			.includes("dropdown-toggle") &&
		link.getAttribute("role") === "button" &&
		link.hasAttribute("aria-expanded")
	);
}
