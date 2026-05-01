import { Defuddle } from "defuddle/node";
import { parseHTML } from "linkedom";
import { hashContent } from "../core/snapshot.ts";
import { uniqueByWhitespace, wordCount } from "../core/text.ts";
import type {
	DiscoverySource,
	FailureKind,
	FetchedUrl,
	FetchResult,
	PageExtractor,
	PageRecord,
} from "../core/types.ts";
import { urlWithoutFragmentAndQuery } from "../core/url.ts";
import {
	isMarkdownLike,
	isStructuredTextAsset,
	languageFromUrl,
} from "./content.ts";
import {
	cleanMarkdown,
	linksFromMarkdown,
	titleFromMarkdown,
} from "./markdown.ts";
import { scoreMarkdown } from "./quality.ts";
import { extractSerializedText } from "./scripts.ts";

type ExtractedBody = {
	markdown: string;
	extractor: PageExtractor;
	title?: string;
	canonicalUrl?: string;
};

export async function extractPage(input: FetchedUrl): Promise<PageRecord> {
	const { result, source } = input;
	const started = performance.now();
	if (!result.ok)
		return failedRecord(result, source, result.error, result.failureKind);

	try {
		const extracted = await extractBody(result);
		const markdown = cleanMarkdown(extracted.markdown);
		if (!markdown)
			return failedRecord(result, source, "empty content", "empty");
		if (isBlockedChallenge(markdown, extracted.title)) {
			return failedRecord(
				result,
				source,
				"blocked by client challenge",
				"blocked",
			);
		}
		const quality = scoreMarkdown(markdown, extracted.title);
		if (extracted.extractor === "fallback" && wordCount(markdown) < 20) {
			quality.confidence = Math.min(quality.confidence, 0.55);
			if (!quality.reasons.includes("thin content"))
				quality.reasons.push("thin content");
		}
		return {
			ok: true,
			url: result.url,
			finalUrl: result.finalUrl,
			...(extracted.canonicalUrl
				? { canonicalUrl: extracted.canonicalUrl }
				: {}),
			...(extracted.title ? { title: extracted.title } : {}),
			markdown,
			links: linksFromMarkdown(markdown),
			status: result.status,
			contentHash: hashContent(markdown),
			extractor: extracted.extractor,
			confidence: quality.confidence,
			qualityReasons: quality.reasons,
			source,
			timings: {
				fetchMs: result.fetchMs,
				extractMs: performance.now() - started,
				writeMs: 0,
			},
		};
	} catch (error) {
		return failedRecord(
			result,
			source,
			error instanceof Error ? error.message : String(error),
			"extract",
		);
	}
}

function isBlockedChallenge(markdown: string, title: string | undefined) {
	return (
		/client challenge/i.test(title ?? "") ||
		/required part of this site couldn.t load/i.test(markdown)
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

	const cleaned = result.body
		.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
		.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "");
	const { document } = parseHTML(cleaned);
	const canonical = resolveCanonical(
		document.querySelector('link[rel="canonical"]')?.getAttribute("href"),
		result.finalUrl,
	);

	const parsed = await parseWithDefuddle(document, result.finalUrl);
	if (parsed?.content?.trim()) {
		const title =
			parsed.title || document.querySelector("title")?.textContent?.trim();
		const markdown = parsed.content.trim();
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
		return {
			...(title ? { title } : {}),
			...(canonical ? { canonicalUrl: canonical } : {}),
			markdown,
			extractor: "html" as const,
		};
	}

	const element =
		document.querySelector("main") ??
		document.querySelector("article") ??
		textElement(document.body) ??
		textElement(document.documentElement);
	const title =
		document.querySelector("h1")?.textContent?.trim() ||
		document.querySelector("title")?.textContent?.trim();
	const fallback =
		element?.textContent?.replace(/\n{3,}/g, "\n\n").trim() ?? "";
	const serialized =
		wordCount(fallback) < 40
			? extractSerializedText(result.body, title)
			: undefined;
	const metadata = serialized ? undefined : metadataMarkdown(document, title);
	return {
		...(title ? { title } : {}),
		...(canonical ? { canonicalUrl: canonical } : {}),
		markdown: serialized ?? (fallback || metadata || ""),
		extractor: "fallback" as const,
	};
}

function textElement(element: Element | null): Element | undefined {
	const text = element?.textContent?.trim() ?? "";
	return wordCount(text) >= 8 ? (element ?? undefined) : undefined;
}

function renderTextAsset(title: string, body: string, url: string) {
	const language = languageFromUrl(url);
	const fence = body.includes("```") ? "````" : "```";
	return `# ${title}\n\n${fence}${language}\n${body.trim()}\n${fence}`;
}

async function parseWithDefuddle(document: Document, url: string) {
	const restore = silenceDefuddleErrors();
	try {
		return await Defuddle(document, url, { markdown: true, debug: false });
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

function failedRecord(
	result: FetchResult,
	source: DiscoverySource,
	error: string,
	failureKind: FailureKind = "extract",
): PageRecord {
	return {
		ok: false,
		url: result.url,
		finalUrl: result.finalUrl,
		markdown: "",
		links: [],
		status: result.status,
		contentHash: "",
		extractor: "none",
		confidence: 0,
		qualityReasons: [],
		source,
		error,
		failureKind,
		timings: { fetchMs: result.fetchMs, extractMs: 0, writeMs: 0 },
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
