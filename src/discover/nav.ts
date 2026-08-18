import { parseHTML } from "linkedom";
import {
	maxGeneratedCapturePages,
	maxGeneratedMediaUrls,
} from "../core/config.ts";
import type { FetchResult } from "../core/types.ts";
import { validatePublicHttpUrl } from "../security/url.ts";
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
	media: string[];
	next?: string;
	nav?: string[];
	feeds?: string[];
	truncated?: boolean;
};

export function discoverPageResources(
	html: string,
	base: string,
	seed = false,
	parsedDocument?: Document,
): PageResources {
	const truncated = html.length > maxDiscoveryHtmlChars;
	const source = truncated ? html.slice(0, maxDiscoveryHtmlChars) : html;
	const document =
		!truncated && parsedDocument ? parsedDocument : parseHTML(source).document;
	const links = new Set(
		discoverMarkdownTextLinks(source, base).slice(0, maxGeneratedCapturePages),
	);
	for (const link of document.querySelectorAll("a[href]")) {
		if (links.size >= maxGeneratedCapturePages) break;
		if (isControlLink(link)) continue;
		const url = normalizeUrl(link.getAttribute("href") ?? "", base);
		if (url) links.add(url);
	}
	const media = new Set<string>();
	for (const node of document.querySelectorAll(
		"img[src],img[srcset],source[src],source[srcset],video[src],video[poster],audio[src],track[src],meta[property='og:image'][content]",
	)) {
		for (const value of mediaValues(node)) {
			const url = normalizeMediaUrl(value, base);
			if (url) media.add(url);
			if (media.size >= maxGeneratedMediaUrls) break;
		}
		if (media.size >= maxGeneratedMediaUrls) break;
	}
	let next: string | undefined;
	const feeds = new Set<string>();
	for (const link of document.querySelectorAll("link[rel][href]")) {
		const rel = relTokens(link);
		const href = link.getAttribute("href");
		const url = href ? normalizeDiscoveryResourceUrl(href, base) : undefined;
		if (!next && rel.includes("next")) next = url;
		if (seed && url && rel.includes("alternate") && feedType(link)) {
			feeds.add(url);
		}
	}
	const resources: PageResources = {
		links: [...links],
		media: [...media],
	};
	if (next) resources.next = next;
	if (seed) {
		resources.nav = discoverLinks(document, base);
		resources.feeds = [...feeds];
	}
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
			media: [],
		};
	}
	return { links: [], media: [] };
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

function feedType(element: Element) {
	const type = element
		.getAttribute("type")
		?.toLowerCase()
		.split(";")[0]
		?.trim();
	return type === "application/rss+xml" || type === "application/atom+xml";
}

function isControlLink(link: Element) {
	const toggle =
		link.getAttribute("data-bs-toggle") ?? link.getAttribute("data-toggle");
	if (toggle?.toLowerCase() === "dropdown") return true;
	return (
		link.classList.contains("dropdown-toggle") &&
		link.getAttribute("role") === "button" &&
		link.hasAttribute("aria-expanded")
	);
}

function mediaValues(node: Element) {
	const values = ["src", "poster", "content"].flatMap((name) => {
		const value = node.getAttribute(name);
		return value ? [value] : [];
	});
	const srcset = node.getAttribute("srcset");
	if (srcset) values.push(...srcsetCandidates(srcset).map(({ url }) => url));
	return values;
}

export function srcsetCandidates(input: string, limit = 100) {
	const out: Array<{ url: string; descriptor: string }> = [];
	const whitespace = (char: string) => /[\t\n\f\r ]/.test(char);
	let index = 0;
	while (index < input.length && out.length < limit) {
		while (
			index < input.length &&
			(whitespace(input[index]!) || input[index] === ",")
		)
			index++;
		const start = index;
		while (index < input.length && !whitespace(input[index]!)) index++;
		let url = input.slice(start, index);
		let ended = false;
		while (url.endsWith(",")) {
			url = url.slice(0, -1);
			ended = true;
		}
		if (!url) continue;
		if (ended) {
			out.push({ url, descriptor: "" });
			continue;
		}
		while (index < input.length && whitespace(input[index]!)) index++;
		const descriptorStart = index;
		let parentheses = 0;
		while (index < input.length) {
			const char = input[index++]!;
			if (char === "(") parentheses++;
			else if (char === ")") parentheses = Math.max(0, parentheses - 1);
			else if (char === "," && parentheses === 0) break;
		}
		out.push({
			url,
			descriptor: input
				.slice(descriptorStart, input[index - 1] === "," ? index - 1 : index)
				.trim(),
		});
	}
	return out;
}

function normalizeMediaUrl(raw: string, base: string) {
	try {
		const url = new URL(raw, base);
		url.hash = "";
		return validatePublicHttpUrl(url.href) ? undefined : url.href;
	} catch {
		return;
	}
}

function discoverMarkdownTextLinks(html: string, base: string) {
	const urls = new Set<string>();
	const text = html.slice(0, 512 * 1024);
	for (const match of text.matchAll(
		/(?:^|[\s"'(>])((?:https?:\/\/|\/|\.{1,2}\/)[^\s<>"'`)]*\.md)(?=$|[\s<>"'`)])/gi,
	)) {
		const index = match.index ?? 0;
		if (
			!/\b(?:llm|markdown)\b/i.test(
				text.slice(Math.max(0, index - 160), index + 240),
			)
		)
			continue;
		const url = normalizeUrl(match[1]!, base);
		if (url) urls.add(url);
		if (urls.size >= maxGeneratedCapturePages) break;
	}
	return [...urls];
}
