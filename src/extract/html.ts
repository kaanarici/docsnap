import { parseHTML } from "linkedom";
import { markdownLinkHrefs } from "../core/markdown.ts";
import { uniqueByWhitespace, wordCount } from "../core/text.ts";
import type {
	FetchedUrl,
	FetchResult,
	PageExtractor,
	PageKind,
	PageRecord,
} from "../core/types.ts";
import { urlWithoutFragment } from "../core/url.ts";
import {
	discoverFetchedResources,
	type PageResources,
} from "../discover/nav.ts";
import {
	blockedAccessError,
	isLanguageSelector,
	isRecoverableAppShell,
	isShellPlaceholder,
} from "./app-shell.ts";
import {
	isCodeTextAsset,
	isMarkdownLike,
	isStructuredTextAsset,
	languageFromContentType,
	languageFromUrl,
} from "./content.ts";
import { parseWithDefuddle } from "./defuddle.ts";
import { extractDocument } from "./document.ts";
import { extractInlineState } from "./inline-state.ts";
import { scriptBlocks } from "./inline-state-scan.ts";
import {
	type ExtractedBody,
	failedRecord,
	recordFromExtracted,
} from "./page-record.ts";
import { structuredFallback } from "./structured-fallback.ts";
import {
	isHiddenElement,
	maxBacktickRun,
	maxOutputChars,
	maxSerializeVisits,
	walkText,
} from "./structured-fallback-shared.ts";
import { titleFromMarkdown } from "./title.ts";

export type ExtractedPage = [PageRecord, PageResources, boolean];

type HtmlExtractKind = Extract<
	PageKind,
	"docs-html" | "article-html" | "app-shell"
>;

type HtmlClass =
	| { kind: HtmlExtractKind }
	| { kind: "empty"; error: string }
	| { kind: "blocked"; error: string };

export async function extractPage(input: FetchedUrl): Promise<ExtractedPage> {
	const { result, source, wasSeed } = input;
	let resources: PageResources = { links: [] };
	let kind: PageKind | undefined;
	const page = (record: PageRecord): ExtractedPage => [
		record,
		resources,
		kind === "app-shell",
	];
	if (!result.ok)
		return page(
			failedRecord(result, source, result.error, result.failureKind, wasSeed),
		);
	if (result.document) {
		kind = "binary";
		const record = await extractDocument(input);
		resources = { links: record.links };
		return page(record);
	}
	if (shouldCheckFeedResponse(result) && isFeedResponse(result)) {
		kind = "feed";
		return page(
			failedRecord(
				result,
				source,
				"feed resource, not a content page",
				"empty",
				wasSeed,
			),
		);
	}

	try {
		const textAsset = isStructuredTextAsset(result) || isCodeTextAsset(result);
		const markdownLike = isMarkdownLike(result);
		const document =
			textAsset || markdownLike ? undefined : parseHTML(result.body).document;
		resources = discoverFetchedResources(result, document);
		if (textAsset || markdownLike) {
			kind = "markdown";
			return page(
				recordFromExtracted(
					input,
					textAsset ? textAssetBody(result) : markdownAssetBody(result),
					kind,
				),
			);
		}
		if (!document) {
			kind = "empty";
			return page(
				failedRecord(result, source, "empty content", "empty", wasSeed),
			);
		}

		const classified = classifyHtml(result, document);
		kind = classified.kind;
		if (classified.kind === "blocked") {
			return page(
				failedRecord(result, source, classified.error, "blocked", wasSeed),
			);
		}
		if (classified.kind === "empty") {
			return page(
				failedRecord(result, source, classified.error, "empty", wasSeed),
			);
		}

		const scripts = scriptBlocks(document);
		const extracted = await extractBody(result, document, classified.kind);
		const staticRecord = recordFromExtracted(input, extracted, classified.kind);
		if (classified.kind !== "app-shell" || scripts.length === 0) {
			return page(staticRecord);
		}
		try {
			const inline = extractInlineState(result.body, result.finalUrl, {
				scripts,
				title: extracted.title,
			});
			if (!inline) return page(staticRecord);
			const inlineRecord = recordFromExtracted(
				input,
				{
					markdown: inline,
					extractor: "inline-state",
					title: titleFromMarkdown(inline, new URL(result.finalUrl).pathname),
				},
				classified.kind,
			);
			return page(
				inlineRecord.ok ||
					inlineRecord.failureKind === "not_found" ||
					inlineRecord.failureKind === "blocked"
					? inlineRecord
					: staticRecord,
			);
		} catch {
			return page(staticRecord);
		}
	} catch (error) {
		return page(
			failedRecord(
				result,
				source,
				error instanceof Error ? error.message : String(error),
				"extract",
				wasSeed,
			),
		);
	}
}

function classifyHtml(result: FetchResult, document: Document): HtmlClass {
	if (!result.body.trim()) {
		return { kind: "empty", error: "empty content" };
	}
	if (isLanguageSelector(result.finalUrl, result.body)) {
		return {
			kind: "empty",
			error: "language selector without article content",
		};
	}
	const title = documentTitle(document);
	const blocked = blockedAccessError(
		document.body?.textContent?.slice(0, 4_000) ?? "",
		title,
		result.body,
	);
	if (blocked) return { kind: "blocked", error: blocked };
	if (isRecoverableAppShell(result.body, document)) {
		return { kind: "app-shell" };
	}
	if (isDocsHtml(document, result)) return { kind: "docs-html" };
	return { kind: "article-html" };
}

function isDocsHtml(document: Document, result: FetchResult) {
	if (document.querySelector("[data-docsnap-root]")) return true;
	if (docsHtmlMarker.test(result.body.slice(0, 131_072))) return true;
	const generator = meta(document, "generator") ?? "";
	if (docsGenerator.test(generator)) return true;
	const main =
		document.querySelector("main,[role=main],article") ?? document.body;
	const headings = main?.querySelectorAll("h1,h2,h3").length ?? 0;
	const tables = main?.querySelectorAll("table").length ?? 0;
	const code = main?.querySelectorAll("pre,table,dl").length ?? 0;
	const navLinks = document.querySelectorAll(
		"nav a, aside a, [class*='sidebar' i] a, [role='navigation'] a",
	).length;
	if (headings >= 1 && tables >= 1) return true;
	if (headings >= 3 && (code >= 2 || navLinks >= 20)) return true;
	try {
		const path = new URL(result.finalUrl).pathname;
		return (
			/\/(?:docs|documentation|reference)(?:\/|$)/i.test(path) &&
			headings >= 2 &&
			navLinks >= 8
		);
	} catch {
		return false;
	}
}

const docsHtmlMarker =
	/data-docsnap-root|data-docsnap-writerside|\b__docusaurus\b|\bdocusaurus\b|\brst-content\b|\bwy-nav|\bsphinxsidebar\b|\bmkdocs\b|\bmd-content\b|\bvitepress\b|\bVPContent\b|\bVPDoc\b|\bnextra-|\bstarlight\b|\bfumadocs\b|\bmintlify\b|\bgitbook\b|\bwriterside\b|\bmdn-main-content\b|\bmain-page-content\b|\breadthedocs\b|\bantora\b|\bswagger-ui\b/i;
const docsGenerator =
	/docusaurus|sphinx|mkdocs|vitepress|starlight|gitbook|antora|jsdoc|typedoc|docfx|writerside/i;

function isFeedResponse(result: FetchResult): boolean {
	const type = result.contentType.toLowerCase().split(";")[0]?.trim() ?? "";
	if (type === "application/rss+xml" || type === "application/atom+xml")
		return true;
	return /<(?:[a-z][\w.-]*:)?(?:feed|rss|rdf)\b/i.test(
		result.body.slice(0, 4096),
	);
}

function shouldCheckFeedResponse(result: FetchResult): boolean {
	if (/(?:rss|atom)\+xml|\bxml\b/i.test(result.contentType)) return true;
	const prefix = result.body
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

async function extractBody(
	result: FetchResult,
	document: Document,
	kind: HtmlExtractKind,
): Promise<ExtractedBody> {
	removeScriptsAndStyles(document);
	removeHiddenElements(document);
	const canonical = resolveCanonical(
		document.querySelector('link[rel="canonical"]')?.getAttribute("href"),
		result.finalUrl,
	);
	const title = documentTitle(document);
	switch (kind) {
		case "app-shell":
			return extractedBody("", "fallback", title, canonical);
		case "docs-html":
			return extractDocsHtml(document, result, title, canonical);
		case "article-html":
			return extractArticleHtml(document, result, title, canonical);
		default: {
			const unexpected: never = kind;
			throw new Error(`unhandled extract kind: ${unexpected}`);
		}
	}
}

function extractDocsHtml(
	document: Document,
	result: FetchResult,
	title: string | undefined,
	canonical: string | undefined,
) {
	return htmlFallback(document, result, title, canonical);
}

async function extractArticleHtml(
	document: Document,
	result: FetchResult,
	title: string | undefined,
	canonical: string | undefined,
) {
	if (document.querySelectorAll("*").length > maxDefuddleElements) {
		return htmlFallback(document, result, title, canonical);
	}
	const parsed = await parseWithDefuddle(document, result.finalUrl);
	if (parsed?.content.trim()) {
		const parsedTitle = title || parsed.title;
		const markdown = parsed.content.trim();
		if (isShellPlaceholder(markdown, parsedTitle, result.body)) {
			return extractedBody("", "fallback", parsedTitle, canonical);
		}
		if (chromeOnlyExtractedMarkdown(markdown)) {
			const fallback = structuredOrFlat(
				freshDocument(result.body),
				result.finalUrl,
			);
			if (wordCount(fallback.markdown) > 20) {
				return extractedBody(
					fallback.markdown,
					fallback.extractor,
					parsedTitle,
					canonical,
					fallback.truncated,
				);
			}
		}
		return extractedBody(markdown, "html", parsedTitle, canonical);
	}
	return htmlFallback(freshDocument(result.body), result, title, canonical);
}

function htmlFallback(
	document: Document,
	result: FetchResult,
	title: string | undefined,
	canonical: string | undefined,
) {
	const fallback = structuredOrFlat(document, result.finalUrl);
	const metadata = fallback.markdown
		? undefined
		: metadataMarkdown(document, title);
	const markdown = fallback.markdown || metadata || "";
	const extractor = fallback.markdown
		? fallback.extractor
		: ("fallback" as const);
	const metadataOnly = !fallback.markdown && Boolean(metadata);
	const shell =
		isShellPlaceholder(markdown, title, result.body) ||
		(metadataOnly && Boolean(markdown));
	return extractedBody(
		shell ? "" : markdown,
		extractor,
		title,
		canonical,
		fallback.truncated,
	);
}

function textAssetBody(result: FetchResult): ExtractedBody {
	const title = titleFromMarkdown("", new URL(result.finalUrl).pathname);
	return extractedBody(
		renderTextAsset(title, result.body, result.finalUrl, result.contentType),
		"text",
		title,
	);
}

function markdownAssetBody(result: FetchResult): ExtractedBody {
	const body = result.body.trim();
	const truncated = body.length > maxOutputChars;
	const markdown = truncated ? body.slice(0, maxOutputChars) : body;
	const title = titleFromMarkdown(markdown, new URL(result.finalUrl).pathname);
	return extractedBody(markdown, "markdown", title, undefined, truncated);
}

function extractedBody(
	markdown: string,
	extractor: PageExtractor,
	title?: string,
	canonicalUrl?: string,
	truncated = false,
): ExtractedBody {
	const extracted: ExtractedBody = { markdown, extractor };
	if (title) extracted.title = title;
	if (canonicalUrl) extracted.canonicalUrl = canonicalUrl;
	if (truncated) extracted.truncated = true;
	return extracted;
}

function freshDocument(html: string) {
	const document = parseHTML(html).document;
	removeScriptsAndStyles(document);
	return document;
}

function removeScriptsAndStyles(document: Document) {
	document.querySelectorAll("script,style").forEach((node) => {
		node.remove();
	});
}

function removeHiddenElements(document: Document) {
	document.querySelectorAll("*").forEach((element) => {
		if (isHiddenElement(element)) element.remove();
	});
}

const maxDefuddleElements = 10_000;

function structuredOrFlat(document: Document, baseUrl: string) {
	const result = structuredFallback(document, baseUrl);
	if (wordCount(result.markdown) >= 20) {
		return { ...result, extractor: "structured" as const };
	}
	const fallback = pageText(document);
	return {
		...fallback,
		extractor: "fallback" as const,
		truncated: result.truncated || fallback.truncated,
	};
}

function pageText(document: Document) {
	const candidates = [
		document.querySelector("main"),
		document.querySelector("article"),
		document.body,
		document.documentElement,
	];
	for (const element of candidates) {
		if (!element) continue;
		const result = readableText(element);
		if (wordCount(result.markdown) >= 8) return result;
	}
	return { markdown: "", truncated: false };
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

function readableText(node: Node) {
	const { parts, textChars, anchorChars, truncated } = walkText(node, {
		maxVisits: maxSerializeVisits,
		collectChars: maxOutputChars,
	});
	if (textChars > 0 && anchorChars / textChars >= 0.5)
		return { markdown: "", truncated };
	return {
		markdown: parts
			.join(" ")
			.replace(/\s+/g, " ")
			.replace(/\s+([,.;:!?])/g, "$1")
			.trim(),
		truncated,
	};
}

function renderTextAsset(
	title: string,
	body: string,
	url: string,
	contentType: string,
) {
	const language = languageFromUrl(url) || languageFromContentType(contentType);
	const fence = "`".repeat(Math.max(3, maxBacktickRun(body) + 1));
	return `# ${title}\n\n${fence}${language}\n${body.trim()}\n${fence}`;
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
