import { Defuddle } from "defuddle/node";
import { parseHTML } from "linkedom";
import { uniqueByWhitespace, wordCount } from "../core/text.ts";
import type { FetchedUrl, FetchResult, PageRecord } from "../core/types.ts";
import { urlWithoutFragmentAndQuery } from "../core/url.ts";
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
import { extractSerializedText } from "./scripts.ts";
import { structuredFallback } from "./structured-fallback.ts";

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

function isShellPlaceholder(
	markdown: string,
	title: string | undefined,
	html: string,
) {
	return (
		(((Boolean(title) &&
			markdown.replace(/^#+\s*/, "").trim() === title?.trim()) ||
			(wordCount(markdown) <= 2 &&
				/raw\.githubusercontent\.com|xhrPromise/i.test(html))) &&
			/catalog-app|react-target|app-root|ohcglobal|__meteor_runtime_config__|raw\.githubusercontent\.com/i.test(
				html,
			)) ||
		(/^\s*search\s*$/i.test(markdown) &&
			/<input[^>]+type=["']search["']|placeholder=["']search["']|class=["'][^"']*search/i.test(
				html,
			) &&
			/__docusaurus/i.test(html)) ||
		(title !== undefined &&
			wordCount(markdown) <= 8 &&
			markdown.includes(title) &&
			/<div[^>]+id=["']app["'][^>]*>\s*<\/div>/i.test(html))
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
		const fallback =
			linkOnlyMarkdown(markdown) ||
			mediaOnlyMarkdown(markdown) ||
			chromeOnlyMarkdown(markdown)
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
	return {
		...(title ? { title } : {}),
		...(canonical ? { canonicalUrl: canonical } : {}),
		markdown: isShellPlaceholder(markdown, title, result.body) ? "" : markdown,
		extractor,
	};
}

function freshDocument(html: string) {
	return parseHTML(html).document;
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
		textElement(document.body) ??
		textElement(document.documentElement);
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

function chromeHeading(text: string) {
	return /^(our api|hello world|support|sign in|search(?: developer site)?)$/i.test(
		text,
	);
}

function linkOnlyMarkdown(markdown: string) {
	const withoutLinks = markdown
		.replace(/\[[^\]]+]\([^)]+\)/g, "")
		.replace(/\s+/g, "");
	return (
		linksFromMarkdown(markdown).length >= 2 &&
		wordCount(markdown) <= 8 &&
		!withoutLinks
	);
}

function mediaOnlyMarkdown(markdown: string) {
	const withoutMedia = markdown
		.replace(/!\[[^\]]*]\([^)]+\)/g, "")
		.replace(/\[[^\]]+]\([^)]+\)/g, "")
		.replace(/\s+/g, "");
	return (
		(markdown.match(/!\[[^\]]*]\([^)]+\)/g) ?? []).length > 0 &&
		wordCount(markdown) <= 6 &&
		!withoutMedia
	);
}

function chromeOnlyMarkdown(markdown: string) {
	const withoutChrome = markdown
		.replace(/!\[[^\]]*]\([^)]+\)/g, "")
		.replace(/\[[^\]]+]\([^)]+\)/g, "")
		.replace(/[>#|/\\\-–—:]+/g, " ");
	const chromeCount =
		(markdown.match(/!\[[^\]]*]\([^)]+\)/g) ?? []).length +
		linksFromMarkdown(markdown).length;
	return (
		chromeCount >= 2 &&
		wordCount(markdown) <= 16 &&
		wordCount(withoutChrome) <= 2
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
			const textChars = visibleChars(value);
			chars += textChars;
			if (frame.inAnchor) anchorChars += textChars;
			continue;
		}
		if (!isReadableElement(frame.node)) continue;
		if (skipReadableElement(frame.node)) continue;
		const inAnchor = frame.inAnchor || readableTag(frame.node) === "a";
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

function isReadableElement(node: Node): node is Element {
	return node.nodeType === 1;
}

function skipReadableElement(element: Element) {
	const tag = readableTag(element);
	return (
		tag === "script" ||
		tag === "style" ||
		tag === "noscript" ||
		tag === "template" ||
		tag === "nav" ||
		tag === "header" ||
		tag === "footer" ||
		tag === "aside" ||
		element.getAttribute("role")?.toLowerCase() === "navigation" ||
		element.hasAttribute("hidden") ||
		element.getAttribute("aria-hidden")?.toLowerCase() === "true" ||
		readableStyleHides(element.getAttribute("style") ?? "")
	);
}

function readableTag(element: Element) {
	return element.tagName.toLowerCase();
}

function readableStyleHides(style: string) {
	for (const declaration of style.slice(0, 2_048).split(";")) {
		const colon = declaration.indexOf(":");
		if (colon < 0) continue;
		const property = declaration.slice(0, colon).trim().toLowerCase();
		const value = declaration
			.slice(colon + 1)
			.trim()
			.toLowerCase();
		if (property === "display" && value.startsWith("none")) return true;
		if (property === "visibility" && value.startsWith("hidden")) return true;
	}
	return false;
}

function visibleChars(value: string) {
	let count = 0;
	for (const char of value) {
		if (
			char !== " " &&
			char !== "\n" &&
			char !== "\r" &&
			char !== "\t" &&
			char !== "\f"
		) {
			count++;
		}
	}
	return count;
}

function textElement(element: Element | null): Element | undefined {
	const text = element ? readableText(element) : "";
	return wordCount(text) >= 8 ? (element ?? undefined) : undefined;
}

function renderTextAsset(title: string, body: string, url: string) {
	const language = languageFromUrl(url);
	const fence = body.includes("```") ? "````" : "```";
	return `# ${title}\n\n${fence}${language}\n${body.trim()}\n${fence}`;
}

export function stripScriptStyleTags(html: string): string {
	return stripCompleteHtmlElement(
		stripCompleteHtmlElement(html, "script"),
		"style",
	);
}

function stripCompleteHtmlElement(html: string, tagName: string): string {
	const lower = html.toLowerCase();
	const openToken = `<${tagName}`;
	const closeToken = `</${tagName}>`;
	let out = "";
	let cursor = 0;
	let index = 0;
	while (index < html.length) {
		const start = lower.indexOf(openToken, index);
		if (start === -1) break;
		const afterName = start + openToken.length;
		if (!tagNameBoundary(lower[afterName])) {
			index = afterName;
			continue;
		}
		const openEnd = html.indexOf(">", afterName);
		if (openEnd === -1) break;
		const end = lower.indexOf(closeToken, openEnd + 1);
		if (end === -1) break;
		out += html.slice(cursor, start);
		cursor = end + closeToken.length;
		index = cursor;
	}
	return cursor === 0 ? html : out + html.slice(cursor);
}

function tagNameBoundary(char: string | undefined) {
	return char === undefined || /[\s>/]/.test(char);
}

async function parseWithDefuddle(document: Document, url: string) {
	const restore = silenceDefuddleErrors();
	try {
		return await Defuddle(document, url, {
			markdown: true,
			debug: false,
			useAsync: false,
		});
	} catch {
		return undefined;
	} finally {
		restore();
	}
}

let defuddleCalls = 0;
const consoleError = console.error.bind(console);
const consoleWarn = console.warn.bind(console);

function silenceDefuddleErrors() {
	if (defuddleCalls++ === 0) {
		console.error = () => {};
		console.warn = () => {};
	}
	return () => {
		defuddleCalls--;
		if (defuddleCalls === 0) {
			console.error = consoleError;
			console.warn = consoleWarn;
		}
	};
}

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
