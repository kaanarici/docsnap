import { Defuddle } from "defuddle/node";
import { parseHTML } from "linkedom";
import { markdownLinkHrefs } from "../core/markdown.ts";
import {
	stripCompleteHtmlElement,
	uniqueByWhitespace,
	wordCount,
} from "../core/text.ts";
import type { FetchedUrl, FetchResult, PageRecord } from "../core/types.ts";
import { urlWithoutFragment } from "../core/url.ts";
import { isFeedResponse } from "../discover/feed.ts";
import { chromeHeading, isShellPlaceholder } from "./app-shell.ts";
import {
	isMarkdownLike,
	isStructuredTextAsset,
	languageFromUrl,
} from "./content.ts";
import {
	type ExtractedBody,
	failedRecord,
	rawInjectionSignals,
	recordFromExtracted,
} from "./page-record.ts";
import { scoreMarkdown } from "./quality.ts";
import { extractSerializedText } from "./serialized-text.ts";
import { structuredFallback } from "./structured-fallback.ts";
import {
	countTextChars,
	isElement,
	maxBacktickRun,
	maxOutputChars,
	maxSerializeVisits,
	shouldSkipElement,
	tagName,
} from "./structured-fallback-shared.ts";
import { titleFromMarkdown } from "./title.ts";

export async function extractPage(input: FetchedUrl): Promise<PageRecord> {
	const { metadata, result, source, wasSeed } = input;
	const started = performance.now();
	if (!result.ok)
		return failedRecord(
			result,
			source,
			metadata,
			result.error,
			result.failureKind,
			[],
			wasSeed,
		);
	// rss/atom feeds are discovery sources, not content pages; exclude them from
	// the corpus instead of capturing the raw feed XML as a page
	if (shouldCheckFeedResponse(result) && isFeedResponse(result))
		return failedRecord(
			result,
			source,
			metadata,
			"feed resource used for discovery, not a content page",
			"empty",
			[],
			wasSeed,
		);
	const signals = rawInjectionSignals(result);

	try {
		const extracted = await extractBody(result);
		return recordFromExtracted(input, extracted, started, signals);
	} catch (error) {
		return failedRecord(
			result,
			source,
			metadata,
			error instanceof Error ? error.message : String(error),
			"extract",
			signals,
			wasSeed,
		);
	}
}

// cheap guard so the feed-root DOM parse only runs for xml-ish responses
// or text/plain bodies that start like feed XML
function shouldCheckFeedResponse(result: FetchResult): boolean {
	return (
		feedLikeContentType(result.contentType) || feedLikeBodyPrefix(result.body)
	);
}

function feedLikeContentType(contentType: string): boolean {
	return /(?:rss|atom)\+xml|\bxml\b/i.test(contentType);
}

function feedLikeBodyPrefix(body: string): boolean {
	const prefix = body
		.slice(0, 2048)
		.replace(/^\uFEFF/, "")
		.trimStart();
	if (/^<(?:rss|feed)\b/i.test(prefix) || /^<rdf:RDF\b/i.test(prefix)) {
		return true;
	}
	return (
		/^<\?xml\b/i.test(prefix) && /<\s*(?:rss|feed|rdf:RDF)\b/i.test(prefix)
	);
}

async function extractBody(result: FetchResult): Promise<ExtractedBody> {
	if (isStructuredTextAsset(result)) {
		const title = titleFromMarkdown("", new URL(result.finalUrl).pathname);
		return {
			title,
			markdown: renderTextAsset(title, result.body, result.finalUrl),
			extractor: "text" as const,
		};
	}
	if (isMarkdownLike(result)) {
		const title = titleFromMarkdown(
			result.body,
			new URL(result.finalUrl).pathname,
		);
		return {
			title,
			markdown: result.body.trim(),
			extractor: "markdown" as const,
		};
	}

	const cleaned = stripScriptStyleTags(result.body);
	const { document } = parseHTML(cleaned);
	const canonical = resolveCanonical(
		document.querySelector('link[rel="canonical"]')?.getAttribute("href"),
		result.finalUrl,
	);
	const documentTitleText = documentTitle(document);
	const outline = largePageOutline(document, result.body, documentTitleText);
	if (outline) {
		return {
			...(documentTitleText ? { title: documentTitleText } : {}),
			...(canonical ? { canonicalUrl: canonical } : {}),
			markdown: outline,
			extractor: "fallback" as const,
		};
	}

	// Skip Defuddle only when the cheap structured pass is already substantial,
	// high-confidence, and not a shell.
	const fast = strongStructuredFastPath(
		document,
		result.finalUrl,
		documentTitleText,
		result.body,
	);
	if (fast) {
		return {
			...(documentTitleText ? { title: documentTitleText } : {}),
			...(canonical ? { canonicalUrl: canonical } : {}),
			markdown: fast,
			extractor: "structured" as const,
		};
	}

	const parsed = await parseWithDefuddle(document, result.finalUrl);
	if (parsed?.content?.trim()) {
		const title = parsed.title || documentTitleText;
		const markdown = parsed.content.trim();
		if (isShellPlaceholder(markdown, title, result.body)) {
			return {
				...(title ? { title } : {}),
				...(canonical ? { canonicalUrl: canonical } : {}),
				markdown: "",
				extractor: "fallback" as const,
			};
		}
		const serialized =
			scoreMarkdown(markdown, title).confidence < 0.6
				? extractSerializedText(result.body, title)
				: undefined;
		if (serialized) {
			return {
				...(title ? { title } : {}),
				...(canonical ? { canonicalUrl: canonical } : {}),
				markdown: serialized,
				extractor: "fallback" as const,
			};
		}
		const fallback = chromeOnlyExtractedMarkdown(markdown)
			? structuredOrFlat(freshDocument(cleaned), result.finalUrl)
			: undefined;
		if (fallback && wordCount(fallback.markdown) > 20) {
			return {
				...(title ? { title } : {}),
				...(canonical ? { canonicalUrl: canonical } : {}),
				markdown: fallback.markdown,
				extractor: fallback.extractor,
			};
		}
		return {
			...(title ? { title } : {}),
			...(canonical ? { canonicalUrl: canonical } : {}),
			markdown,
			extractor: "html" as const,
		};
	}

	const title = documentTitleText;
	const fallbackDocument = freshDocument(cleaned);
	const fallback = structuredOrFlat(fallbackDocument, result.finalUrl);
	const serialized =
		wordCount(fallback.markdown) < 40
			? extractSerializedText(result.body, title)
			: undefined;
	const metadata = serialized
		? undefined
		: metadataMarkdown(fallbackDocument, title);
	const markdown = serialized ?? (fallback.markdown || metadata || "");
	const extractor = serialized
		? ("fallback" as const)
		: fallback.markdown
			? fallback.extractor
			: ("fallback" as const);
	// Meta-tag-only output is marketing copy, not captured page content.
	const metadataOnly = !serialized && !fallback.markdown && Boolean(metadata);
	const isShell =
		isShellPlaceholder(markdown, title, result.body) ||
		(metadataOnly && Boolean(markdown));
	return {
		...(title ? { title } : {}),
		...(canonical ? { canonicalUrl: canonical } : {}),
		markdown: isShell ? "" : markdown,
		extractor,
	};
}

function freshDocument(html: string) {
	return parseHTML(html).document;
}

const fastPathMinWords = 200;
const fastPathMinConfidence = 0.9;
function strongStructuredFastPath(
	document: Document,
	baseUrl: string,
	title: string | undefined,
	html: string,
): string | undefined {
	const markdown = structuredFallback(document, baseUrl);
	if (!markdown || wordCount(markdown) < fastPathMinWords) return undefined;
	if (isShellPlaceholder(markdown, title, html)) return undefined;
	if (scoreMarkdown(markdown, title).confidence < fastPathMinConfidence) {
		return undefined;
	}
	return markdown;
}

function structuredOrFlat(
	document: Document,
	baseUrl: string,
): { markdown: string; extractor: "structured" | "fallback" } {
	const structured = structuredFallback(document, baseUrl);
	if (wordCount(structured) >= 20) {
		return { markdown: structured, extractor: "structured" };
	}
	return { markdown: pageText(document), extractor: "fallback" };
}

function pageText(document: Document) {
	const element =
		document.querySelector("main") ??
		document.querySelector("article") ??
		elementWithText(document.body) ??
		elementWithText(document.documentElement);
	return element ? readableText(element) : "";
}

function largePageOutline(
	document: Document,
	html: string,
	title: string | undefined,
) {
	if (html.length < 2_000_000 || document.querySelectorAll("a").length < 500)
		return undefined;
	const headings = uniqueByWhitespace(
		Array.from(document.querySelectorAll("h1,h2,h3"))
			.map((element) => element.textContent?.replace(/\s+/g, " ").trim())
			.filter((text): text is string => Boolean(text) && !chromeHeading(text)),
	).slice(0, 120);
	if (headings.length < 3) return undefined;
	const parts = [
		title ? `# ${title}` : undefined,
		meta(document, "description"),
		`## Page Outline\n\n${headings.map((heading) => `- ${heading}`).join("\n")}`,
	].filter((value): value is string => Boolean(value?.trim()));
	const markdown = uniqueByWhitespace(parts).join("\n\n");
	return wordCount(markdown) >= 8 ? markdown : undefined;
}

function chromeOnlyExtractedMarkdown(markdown: string) {
	const words = wordCount(markdown);
	const linkCount = markdownLinkHrefs(markdown).length;
	const imageCount = (markdown.match(/!\[[^\]]*]\([^)]+\)/g) ?? []).length;
	const withoutLinks = markdown
		.replace(/\[[^\]]+]\([^)]+\)/g, "")
		.replace(/\s+/g, "");
	if (linkCount >= 2 && words <= 8 && !withoutLinks) return true;
	const withoutMedia = markdown
		.replace(/!\[[^\]]*]\([^)]+\)/g, "")
		.replace(/\[[^\]]+]\([^)]+\)/g, "")
		.replace(/\s+/g, "");
	if (imageCount > 0 && words <= 6 && !withoutMedia) return true;
	const withoutChrome = markdown
		.replace(/!\[[^\]]*]\([^)]+\)/g, "")
		.replace(/\[[^\]]+]\([^)]+\)/g, "")
		.replace(/[>#|/\\\-–—:]+/g, " ");
	return (
		imageCount + linkCount >= 2 && words <= 16 && wordCount(withoutChrome) <= 2
	);
}

function readableText(node: Node): string {
	const parts: string[] = [];
	const stack: Array<{ node: Node; inAnchor: boolean }> = [
		{ node, inAnchor: false },
	];
	let visits = 0;
	let chars = 0;
	let anchorChars = 0;
	while (
		stack.length > 0 &&
		visits++ < maxSerializeVisits &&
		chars < maxOutputChars
	) {
		const frame = stack.pop()!;
		if (frame.node.nodeType === 3) {
			const value = frame.node.textContent ?? "";
			parts.push(value);
			const textChars = countTextChars(value);
			chars += textChars;
			if (frame.inAnchor) anchorChars += textChars;
			continue;
		}
		if (!isElement(frame.node)) continue;
		if (shouldSkipElement(frame.node)) continue;
		const inAnchor = frame.inAnchor || tagName(frame.node) === "a";
		const children = frame.node.childNodes;
		const remaining = Math.max(0, maxSerializeVisits - visits);
		let pushed = 0;
		for (let index = children.length - 1; index >= 0; index--) {
			if (pushed >= remaining) break;
			const child = children[index];
			if (!child) continue;
			stack.push({ node: child, inAnchor });
			pushed++;
		}
	}
	if (chars > 0 && anchorChars / chars >= 0.5) return "";
	return parts
		.join(" ")
		.replace(/\s+/g, " ")
		.replace(/\s+([,.;:!?])/g, "$1")
		.trim();
}

function elementWithText(element: Element | null): Element | undefined {
	const text = element ? readableText(element) : "";
	return wordCount(text) >= 8 ? (element ?? undefined) : undefined;
}

function renderTextAsset(title: string, body: string, url: string) {
	const language = languageFromUrl(url);
	// fence must be longer than the longest backtick run in the body, or it
	// closes early and strands content (mirrors codeBlock in structured-fallback)
	const fence = "`".repeat(Math.max(3, maxBacktickRun(body) + 1));
	return `# ${title}\n\n${fence}${language}\n${body.trim()}\n${fence}`;
}

function stripScriptStyleTags(html: string): string {
	return stripCompleteHtmlElement(
		stripCompleteHtmlElement(html, "script"),
		"style",
	);
}

// Defuddle can write parse warnings to stderr; silence only during active parses.
let activeDefuddleParses = 0;
let restoreConsole: (() => void) | undefined;

function silenceConsoleDuringParse() {
	if (activeDefuddleParses++ > 0) return;
	const error = console.error;
	const warn = console.warn;
	console.error = () => {};
	console.warn = () => {};
	restoreConsole = () => {
		console.error = error;
		console.warn = warn;
	};
}

function endDefuddleParse() {
	if (--activeDefuddleParses > 0) return;
	restoreConsole?.();
	restoreConsole = undefined;
}

async function parseWithDefuddle(document: Document, url: string) {
	silenceConsoleDuringParse();
	try {
		return await Defuddle(document, url, {
			markdown: true,
			useAsync: false,
		});
	} catch {
		return undefined;
	} finally {
		endDefuddleParse();
	}
}

function resolveCanonical(href: string | null | undefined, base: string) {
	if (!href) return undefined;
	try {
		return urlWithoutFragment(href, base);
	} catch {
		return undefined;
	}
}

function metadataMarkdown(document: Document, title: string | undefined) {
	const values = uniqueByWhitespace(
		[
			title ? `# ${title}` : undefined,
			meta(document, "description"),
			meta(document, "og:description"),
			meta(document, "twitter:description"),
		].filter((value): value is string => Boolean(value?.trim())),
	);
	return wordCount(values.join(" ")) >= 8 ? values.join("\n\n") : undefined;
}

function documentTitle(document: Document) {
	return (
		document.querySelector("h1")?.textContent?.trim() ||
		document.querySelector("title")?.textContent?.trim() ||
		meta(document, "og:title") ||
		meta(document, "twitter:title")
	);
}

function meta(document: Document, name: string) {
	for (const element of document.querySelectorAll("meta")) {
		const key =
			element.getAttribute("name") ?? element.getAttribute("property");
		if (key?.toLowerCase() !== name.toLowerCase()) continue;
		const content = element.getAttribute("content")?.trim();
		if (content) return content;
	}
	return undefined;
}
