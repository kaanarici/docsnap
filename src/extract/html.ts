import { parseHTML } from "linkedom";
import { markdownLinkHrefs } from "../core/markdown.ts";
import { uniqueByWhitespace, wordCount } from "../core/text.ts";
import {
	type FetchedUrl,
	type FetchResult,
	lowQualityConfidence,
	type PageExtractor,
	type PageRecord,
} from "../core/types.ts";
import { urlWithoutFragment } from "../core/url.ts";
import { isFeedResponse } from "../discover/feed.ts";
import {
	discoverFetchedResources,
	type PageResources,
} from "../discover/nav.ts";
import { scanRawHtmlForInjectionSignals } from "../security/injection.ts";
import {
	chromeHeading,
	isRecoverableAppShell,
	isShellPlaceholder,
} from "./app-shell.ts";
import {
	isMarkdownLike,
	isStructuredTextAsset,
	languageFromUrl,
} from "./content.ts";
import { extractDocument } from "./document.ts";
import { extractInlineState } from "./inline-state.ts";
import { scriptBlocks } from "./inline-state-scan.ts";
import {
	type ExtractedBody,
	failedRecord,
	recordFromExtracted,
} from "./page-record.ts";
import { scoreMarkdown } from "./quality.ts";
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

export async function extractPage(input: FetchedUrl): Promise<ExtractedPage> {
	const { metadata, result, source, wasSeed } = input;
	const started = performance.now();
	let resources: PageResources = { links: [], media: [] };
	let shell = false;
	const page = (record: PageRecord): ExtractedPage => [
		record,
		resources,
		shell,
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
		const record = await extractDocument(input, started);
		resources = {
			links: record.links,
			media: record.ok ? (record.media ?? []) : [],
		};
		return page(record);
	}
	// rss/atom feeds are discovery sources, not content pages; exclude them from
	// the corpus instead of capturing the raw feed XML as a page
	if (shouldCheckFeedResponse(result) && isFeedResponse(result))
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
	let signals: PageRecord["injectionSignals"] = [];

	try {
		const document =
			isStructuredTextAsset(result) || isMarkdownLike(result)
				? undefined
				: parseHTML(result.body).document;
		resources = discoverFetchedResources(result, document);
		signals = isMarkdownLike(result)
			? []
			: scanRawHtmlForInjectionSignals(result.body, document);
		const scripts = document ? scriptBlocks(document) : undefined;
		shell = document ? isRecoverableAppShell(result.body, document) : false;
		const extracted = await extractBody(result, document, shell);
		const staticRecord = recordFromExtracted(
			input,
			extracted,
			started,
			signals,
			shell,
		);
		if (!scripts || !shouldRecoverInlineState(shell, staticRecord)) {
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
				shell,
			);
			return page(
				(!inlineRecord.ok &&
					(inlineRecord.failureKind === "not_found" ||
						inlineRecord.failureKind === "blocked")) ||
					(inlineRecord.ok && inlineRecord.confidence >= lowQualityConfidence)
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

function shouldRecoverInlineState(shell: boolean, record: PageRecord) {
	if (
		record.ok &&
		record.confidence >= 0.9 &&
		(record.extractor === "html" ||
			(record.extractor === "structured" && wordCount(record.markdown) >= 200))
	) {
		return false;
	}
	if (!shell) return false;
	return record.ok
		? record.confidence < lowQualityConfidence ||
				record.extractor === "fallback" ||
				record.extractor === "structured"
		: record.failureKind === "empty" || record.failureKind === "extract";
}

// Fast precheck so the feed-root DOM parse only runs for XML-ish responses
// or text/plain bodies that start like feed XML
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
	parsedDocument?: Document,
	shell = false,
): Promise<ExtractedBody> {
	if (isStructuredTextAsset(result)) {
		const title = titleFromMarkdown("", new URL(result.finalUrl).pathname);
		return extractedBody(
			renderTextAsset(title, result.body, result.finalUrl),
			"text",
			title,
		);
	}
	if (isMarkdownLike(result)) {
		const body = result.body.trim();
		const truncated = body.length > maxOutputChars;
		const markdown = truncated ? body.slice(0, maxOutputChars) : body;
		const title = titleFromMarkdown(
			markdown,
			new URL(result.finalUrl).pathname,
		);
		return extractedBody(
			markdown,
			"markdown",
			title,
			undefined,
			truncated,
			truncated ? body : undefined,
		);
	}

	const document = parsedDocument ?? parseHTML(result.body).document;
	removeScriptsAndStyles(document);
	const canonical = resolveCanonical(
		document.querySelector('link[rel="canonical"]')?.getAttribute("href"),
		result.finalUrl,
	);
	const documentTitleText = documentTitle(document);
	const outline = largePageOutline(document, result.body, documentTitleText);
	if (outline) {
		return extractedBody(outline, "fallback", documentTitleText, canonical);
	}

	if (document.querySelectorAll("*").length > maxDefuddleElements) {
		const fallback = structuredOrFlat(document, result.finalUrl);
		return extractedBody(
			fallback.markdown,
			fallback.extractor,
			documentTitleText,
			canonical,
			fallback.truncated,
		);
	}
	// Skip Defuddle only when the structured pass is already substantial,
	// high-confidence, and not a shell.
	const structuredStatus = { truncated: false };
	const structured = {
		markdown: structuredFallback(document, result.finalUrl, structuredStatus),
		...structuredStatus,
	};
	if (
		isStrongStructuredFastPath(
			structured.markdown,
			document,
			documentTitleText,
			result.body,
		)
	) {
		return extractedBody(
			structured.markdown,
			"structured",
			documentTitleText,
			canonical,
			structured.truncated,
		);
	}
	const declared = shell ? declaredMarkdown(document) : undefined;
	if (declared && wordCount(structured.markdown) < 20) {
		return extractedBody(
			declared.markdown,
			"markdown",
			documentTitleText,
			canonical,
			declared.truncated,
			declared.injectionSource,
		);
	}

	const parsed = await parseWithDefuddle(document, result.finalUrl);
	if (parsed?.content?.trim()) {
		const title = parsed.title || documentTitleText;
		const markdown = parsed.content.trim();
		if (isShellPlaceholder(markdown, title, result.body)) {
			return extractedBody("", "fallback", title, canonical);
		}
		const fallback = chromeOnlyExtractedMarkdown(markdown)
			? structuredOrFlat(
					freshDocument(result.body),
					result.finalUrl,
					structured,
				)
			: undefined;
		if (fallback && wordCount(fallback.markdown) > 20) {
			return extractedBody(
				fallback.markdown,
				fallback.extractor,
				title,
				canonical,
				fallback.truncated,
			);
		}
		return extractedBody(markdown, "html", title, canonical);
	}

	const title = documentTitleText;
	const fallbackDocument = freshDocument(result.body);
	const fallback = structuredOrFlat(
		fallbackDocument,
		result.finalUrl,
		structured,
	);
	const metadata = fallback.markdown
		? undefined
		: metadataMarkdown(fallbackDocument, title);
	const markdown = fallback.markdown || metadata || "";
	const extractor = fallback.markdown
		? fallback.extractor
		: ("fallback" as const);
	// Meta-tag-only output is marketing copy, not captured page content.
	const metadataOnly = !fallback.markdown && Boolean(metadata);
	const isShell =
		isShellPlaceholder(markdown, title, result.body) ||
		(metadataOnly && Boolean(markdown));
	return extractedBody(
		isShell ? "" : markdown,
		extractor,
		title,
		canonical,
		fallback.truncated,
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

const fastPathMinWords = 200;
const fastPathMinConfidence = 0.9;
const maxDefuddleElements = 10_000;

type DeclaredMarkdown = {
	markdown: string;
	truncated: boolean;
	injectionSource?: string;
};

function isStrongStructuredFastPath(
	markdown: string,
	document: Document,
	title: string | undefined,
	html: string,
): boolean {
	const minWords = document.querySelector("[data-docsnap-root]")
		? 20
		: fastPathMinWords;
	if (
		!markdown ||
		wordCount(markdown) < minWords ||
		!/^#{1,6}\s+/m.test(markdown)
	)
		return false;
	if (isShellPlaceholder(markdown, title, html)) return false;
	if (minWords < fastPathMinWords) return true;
	const referenceLinkCount =
		markdown.match(/^[ \t]*- \[[^\]]+\]\([^)]+\)$/gm)?.length ?? 0;
	return (
		scoreMarkdown(markdown, title).confidence >= fastPathMinConfidence ||
		referenceLinkCount >= 50
	);
}

function structuredOrFlat(
	document: Document,
	baseUrl: string,
	structured?: { markdown: string; truncated: boolean },
) {
	const status = { truncated: false };
	const result = structured ?? {
		markdown: structuredFallback(document, baseUrl, status),
		...status,
	};
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
	// Fence must be longer than the longest backtick run in the body, or it
	// closes early and splits the rendered block.
	const fence = "`".repeat(Math.max(3, maxBacktickRun(body) + 1));
	return `# ${title}\n\n${fence}${language}\n${body.trim()}\n${fence}`;
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
		const { Defuddle } = await import("defuddle/node");
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
