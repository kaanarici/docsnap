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
import { isFeedResponse } from "../discover/feed.ts";
import {
	discoverFetchedResources,
	type PageResources,
} from "../discover/nav.ts";
import { scanRawHtmlForInjectionSignals } from "../security/injection.ts";
import {
	blockedAccessError,
	chromeHeading,
	isLanguageSelector,
	isRecoverableAppShell,
	isShellPlaceholder,
} from "./app-shell.ts";
import {
	isMarkdownLike,
	isStructuredTextAsset,
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
	countTextChars,
	isElement,
	maxBacktickRun,
	maxOutputChars,
	maxSerializeVisits,
	shouldSkipElement,
	tagName,
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
	const { metadata, result, source, wasSeed } = input;
	const started = performance.now();
	let resources: PageResources = { links: [], media: [] };
	let kind: PageKind | undefined;
	const page = (record: PageRecord): ExtractedPage => [
		record,
		resources,
		kind === "app-shell",
	];
	if (!result.ok)
		return page(
			failedRecord(
				result,
				source,
				metadata,
				result.error,
				result.failureKind,
				[],
				wasSeed,
			),
		);
	if (result.document) {
		kind = "binary";
		const record = await extractDocument(input, started);
		resources = {
			links: record.links,
			media: record.ok ? (record.media ?? []) : [],
		};
		return page(record);
	}
	if (shouldCheckFeedResponse(result) && isFeedResponse(result)) {
		kind = "feed";
		return page(
			failedRecord(
				result,
				source,
				metadata,
				"feed resource used for discovery, not a content page",
				"empty",
				[],
				wasSeed,
			),
		);
	}
	let signals: PageRecord["injectionSignals"] = [];

	try {
		const textAsset = isStructuredTextAsset(result);
		const markdownLike = isMarkdownLike(result);
		const document =
			textAsset || markdownLike ? undefined : parseHTML(result.body).document;
		resources = discoverFetchedResources(result, document);
		signals = markdownLike
			? []
			: scanRawHtmlForInjectionSignals(result.body, document);
		if (textAsset || markdownLike) {
			kind = "markdown";
			return page(
				recordFromExtracted(
					input,
					textAsset ? textAssetBody(result) : markdownAssetBody(result),
					started,
					signals,
					kind,
				),
			);
		}
		if (!document) {
			kind = "empty";
			return page(
				failedRecord(
					result,
					source,
					metadata,
					"empty content",
					"empty",
					signals,
					wasSeed,
				),
			);
		}

		const classified = classifyHtml(result, document);
		kind = classified.kind;
		if (classified.kind === "blocked") {
			return page(
				failedRecord(
					result,
					source,
					metadata,
					classified.error,
					"blocked",
					signals,
					wasSeed,
				),
			);
		}
		if (classified.kind === "empty") {
			return page(
				failedRecord(
					result,
					source,
					metadata,
					classified.error,
					"empty",
					signals,
					wasSeed,
				),
			);
		}

		const scripts = scriptBlocks(document);
		const extracted = await extractBody(result, document, classified.kind);
		const staticRecord = recordFromExtracted(
			input,
			extracted,
			started,
			signals,
			classified.kind,
		);
		if (classified.kind !== "app-shell" || scripts.length === 0) {
			return page(staticRecord);
		}
		try {
			const inlineStarted = performance.now();
			const inline = extractInlineState(result.body, result.finalUrl, {
				scripts,
				title: extracted.title,
			});
			if (!inline) return page(staticRecord);
			const inlineRecord = recordFromExtracted(
				input,
				{
					markdown: inline.markdown,
					extractor: "inline-state",
					inlineStateSource: inline.source,
					title: titleFromMarkdown(
						inline.markdown,
						new URL(result.finalUrl).pathname,
					),
				},
				inlineStarted,
				signals,
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
				metadata,
				error instanceof Error ? error.message : String(error),
				"extract",
				signals,
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
	if (docsHtmlMarker.test(result.body)) return true;
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
	const canonical = resolveCanonical(
		document.querySelector('link[rel="canonical"]')?.getAttribute("href"),
		result.finalUrl,
	);
	const title = documentTitle(document);
	switch (kind) {
		case "app-shell":
			return extractAppShell(document, title, canonical);
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

function extractAppShell(
	document: Document,
	title: string | undefined,
	canonical: string | undefined,
) {
	const declared = declaredMarkdown(document);
	if (declared && wordCount(declared.markdown) >= 20) {
		return extractedBody(
			declared.markdown,
			"markdown",
			title,
			canonical,
			declared.truncated,
			declared.injectionSource,
		);
	}
	return extractedBody("", "fallback", title, canonical);
}

function extractDocsHtml(
	document: Document,
	result: FetchResult,
	title: string | undefined,
	canonical: string | undefined,
) {
	const outline = largePageOutline(document, result.body, title);
	if (outline) return extractedBody(outline, "fallback", title, canonical);
	return htmlFallback(document, result, title, canonical);
}

async function extractArticleHtml(
	document: Document,
	result: FetchResult,
	title: string | undefined,
	canonical: string | undefined,
) {
	const outline = largePageOutline(document, result.body, title);
	if (outline) return extractedBody(outline, "fallback", title, canonical);
	if (document.querySelectorAll("*").length > maxDefuddleElements) {
		return htmlFallback(document, result, title, canonical);
	}
	const parsed = await parseWithDefuddle(document, result.finalUrl);
	if (parsed?.content.trim()) {
		const parsedTitle = parsed.title || title;
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
		renderTextAsset(title, result.body, result.finalUrl),
		"text",
		title,
	);
}

function markdownAssetBody(result: FetchResult): ExtractedBody {
	const body = result.body.trim();
	const truncated = body.length > maxOutputChars;
	const markdown = truncated ? body.slice(0, maxOutputChars) : body;
	const title = titleFromMarkdown(markdown, new URL(result.finalUrl).pathname);
	return extractedBody(
		markdown,
		"markdown",
		title,
		undefined,
		truncated,
		truncated ? body : undefined,
	);
}

function extractedBody(
	markdown: string,
	extractor: PageExtractor,
	title?: string,
	canonicalUrl?: string,
	truncated = false,
	injectionSource?: string,
): ExtractedBody {
	const extracted: ExtractedBody = { markdown, extractor };
	if (title) extracted.title = title;
	if (canonicalUrl) extracted.canonicalUrl = canonicalUrl;
	if (truncated) extracted.truncated = true;
	if (injectionSource) extracted.injectionSource = injectionSource;
	return extracted;
}

function declaredMarkdown(document: Document) {
	let markdown = "";
	for (const node of document.querySelectorAll("pre[data-content-type]")) {
		const type = node
			.getAttribute("data-content-type")
			?.split(";", 1)[0]
			?.trim()
			.toLowerCase();
		const text = node.textContent?.trim() ?? "";
		if (
			type === "text/markdown" &&
			node.closest('[aria-hidden="true"],[hidden]') &&
			wordCount(text) >= 20 &&
			text.length > markdown.length
		) {
			markdown = text;
		}
	}
	if (!markdown) return undefined;
	const truncated = markdown.length > maxOutputChars;
	const declared: DeclaredMarkdown = {
		markdown: truncated ? markdown.slice(0, maxOutputChars) : markdown,
		truncated,
	};
	if (truncated) declared.injectionSource = markdown;
	return declared;
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

const maxDefuddleElements = 10_000;

type DeclaredMarkdown = {
	markdown: string;
	truncated: boolean;
	injectionSource?: string;
};

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

function readableText(node: Node) {
	const parts: string[] = [];
	const stack: Array<{ node: Node; inAnchor: boolean }> = [
		{ node, inAnchor: false },
	];
	let visits = 0;
	let chars = 0;
	let outputChars = 0;
	let anchorChars = 0;
	let clipped = false;
	while (
		stack.length > 0 &&
		visits++ < maxSerializeVisits &&
		outputChars < maxOutputChars
	) {
		const frame = stack.pop()!;
		if (frame.node.nodeType === 3) {
			const raw = frame.node.textContent ?? "";
			const value = raw.slice(0, maxOutputChars - outputChars);
			clipped ||= value.length < raw.length;
			parts.push(value);
			outputChars += value.length;
			const textChars = countTextChars(value);
			chars += textChars;
			if (frame.inAnchor) anchorChars += textChars;
			continue;
		}
		if (!isElement(frame.node) || shouldSkipElement(frame.node)) continue;
		const inAnchor = frame.inAnchor || tagName(frame.node) === "a";
		const children = frame.node.childNodes;
		const remaining = Math.max(0, maxSerializeVisits - visits);
		let pushed = 0;
		for (
			let index = children.length - 1;
			index >= 0 && pushed < remaining;
			index--
		) {
			const child = children[index];
			if (!child) continue;
			stack.push({ node: child, inAnchor });
			pushed++;
		}
	}
	const truncated = clipped || visits >= maxSerializeVisits || stack.length > 0;
	if (chars > 0 && anchorChars / chars >= 0.5)
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

function renderTextAsset(title: string, body: string, url: string) {
	const language = languageFromUrl(url);
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
