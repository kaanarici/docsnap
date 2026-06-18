import { Defuddle } from "defuddle/node";
import { parseHTML } from "linkedom";
import {
	stripCompleteHtmlElement,
	uniqueByWhitespace,
	wordCount,
} from "../core/text.ts";
import type { FetchedUrl, FetchResult, PageRecord } from "../core/types.ts";
import { urlWithoutFragmentAndQuery } from "../core/url.ts";
import { isFeedResponse } from "../discover/feed.ts";
import { chromeHeading, isShellPlaceholder } from "./app-shell.ts";
import {
	isMarkdownLike,
	isStructuredTextAsset,
	languageFromUrl,
} from "./content.ts";
import { linksFromMarkdown, titleFromMarkdown } from "./markdown.ts";
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
	shouldSkipElement,
	tagName,
} from "./structured-fallback-shared.ts";

export async function extractPage(input: FetchedUrl): Promise<PageRecord> {
	const { metadata, result, source } = input;
	const started = performance.now();
	if (!result.ok)
		return failedRecord(
			result,
			source,
			metadata,
			result.error,
			result.failureKind,
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

	// Defuddle is ~90% of cold extraction time. When the page has a clear semantic
	// main-content container, the cheap structured extractor already matches it
	// (verified equivalent content on real docs), so skip the expensive pass when
	// its result is strong and confident. Cluttered pages with no main/article, or
	// a weak/low-confidence structured result, still fall through to Defuddle.
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
	// Meta-tag-only output means nothing real was extracted — the markdown is just
	// the page's og/twitter description (marketing copy), not captured content. Fail
	// honestly so inline-state can still recover real JS state and content-less
	// shells/skeletons record as empty rather than masquerading as a captured page.
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

// Returns structured markdown only when it is confidently the page's real content
// (substantial prose, high quality score, not a shell), so the caller can skip the
// costly Defuddle pass. structuredFallback already finds and gates the content root
// (returning "" for weak/link-dominated roots), so no semantic-container requirement
// is needed; conservative word/confidence/shell gates keep clutter on Defuddle.
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
	const linkCount = linksFromMarkdown(markdown).length;
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
	while (stack.length > 0 && visits++ < 60_000 && chars < 200_000) {
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
		const remaining = Math.max(0, 60_000 - visits);
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

export function stripScriptStyleTags(html: string): string {
	return stripCompleteHtmlElement(
		stripCompleteHtmlElement(html, "script"),
		"style",
	);
}

async function parseWithDefuddle(document: Document, url: string) {
	activeDefuddleParses++;
	try {
		return await Defuddle(document, url, {
			markdown: true,
			debug: false,
			useAsync: false,
		});
	} catch {
		return undefined;
	} finally {
		activeDefuddleParses--;
	}
}

// Defuddle logs parse warnings straight to console; we drop them while a parse
// is in flight. The console wrappers are installed once at module load and never
// reassigned, so concurrent extractPage calls cannot race a save/restore the way
// a swap-and-restore would — they only adjust a depth counter. Anything emitted
// outside a Defuddle parse passes through untouched, preserving real CLI stderr.
let activeDefuddleParses = 0;

function installDefuddleConsoleFilter() {
	const error = console.error.bind(console);
	const warn = console.warn.bind(console);
	console.error = (...args: unknown[]) => {
		if (activeDefuddleParses === 0) error(...args);
	};
	console.warn = (...args: unknown[]) => {
		if (activeDefuddleParses === 0) warn(...args);
	};
}

installDefuddleConsoleFilter();

function resolveCanonical(href: string | null | undefined, base: string) {
	if (!href) return undefined;
	try {
		return urlWithoutFragmentAndQuery(href, base);
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
