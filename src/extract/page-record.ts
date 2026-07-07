import { markdownLinkHrefs } from "../core/markdown.ts";
import { hashContent } from "../core/snapshot.ts";
import { wordCount } from "../core/text.ts";
import type {
	DiscoverySource,
	FailureKind,
	FetchedUrl,
	FetchResult,
	InlineStateSource,
	PageExtractor,
	PageRecord,
} from "../core/types.ts";
import {
	scanMarkdownForInjectionSignals,
	scanRawHtmlForInjectionSignals,
} from "../security/injection.ts";
import {
	blockedAccessError,
	emptyContentError,
	isLanguageSelector,
	isLoadingShellPlaceholder,
	reportedNotFoundError,
} from "./app-shell.ts";
import { isMarkdownLike } from "./content.ts";
import { cleanMarkdown } from "./markdown.ts";
import { scoreMarkdown } from "./quality.ts";
import { titleFromContent } from "./title.ts";

export type ExtractedBody = {
	markdown: string;
	extractor: PageExtractor;
	inlineStateSource?: InlineStateSource;
	title?: string;
	canonicalUrl?: string;
};

export function recordFromExtracted(
	input: FetchedUrl,
	extracted: ExtractedBody,
	started: number,
	rawSignals: PageRecord["injectionSignals"],
): PageRecord {
	const { metadata, result, source, wasSeed } = input;
	const markdown = cleanMarkdown(extracted.markdown);
	const title = titleFromContent(markdown, extracted.title);
	if (!markdown)
		return failedRecord(
			result,
			source,
			metadata,
			emptyContentError(result.body),
			"empty",
			rawSignals,
			wasSeed,
		);
	if (isLoadingShellPlaceholder(markdown, result.body)) {
		return failedRecord(
			result,
			source,
			metadata,
			"app shell without static text",
			"empty",
			rawSignals,
			wasSeed,
		);
	}
	const reportedNotFound = reportedNotFoundError(markdown, title);
	if (reportedNotFound) {
		return failedRecord(
			result,
			source,
			metadata,
			reportedNotFound,
			"not_found",
			rawSignals,
			wasSeed,
		);
	}
	const blocked = blockedAccessError(markdown, title, result.body);
	if (blocked) {
		return failedRecord(
			result,
			source,
			metadata,
			blocked,
			"blocked",
			rawSignals,
			wasSeed,
		);
	}
	if (isLanguageSelector(result.finalUrl, result.body)) {
		return failedRecord(
			result,
			source,
			metadata,
			"language selector without article content",
			"empty",
			rawSignals,
			wasSeed,
		);
	}
	const injectionSignals = uniqueSignals([
		...rawSignals,
		...(title ? scanMarkdownForInjectionSignals(title) : []),
		...scanMarkdownForInjectionSignals(extracted.markdown),
		...scanMarkdownForInjectionSignals(markdown),
	]);
	const quality = scoreMarkdown(markdown, title);
	const links = markdownLinkHrefs(markdown);
	if (
		isChromeOnlyHtml(
			markdown,
			title,
			extracted.extractor,
			quality,
			links.length,
		)
	) {
		return failedRecord(
			result,
			source,
			metadata,
			"page chrome without article content",
			"empty",
			injectionSignals,
			wasSeed,
		);
	}
	if (
		(extracted.extractor === "fallback" ||
			extracted.extractor === "structured") &&
		wordCount(markdown) < 20 &&
		quality.reasons.includes("thin content")
	) {
		quality.confidence = Math.min(quality.confidence, 0.55);
	}
	return {
		ok: true,
		url: result.url,
		finalUrl: result.finalUrl,
		redirects: result.redirects ?? [],
		...(result.etag ? { etag: result.etag } : {}),
		...(result.lastModified ? { lastModified: result.lastModified } : {}),
		fetchedAt: result.fetchedAt ?? new Date().toISOString(),
		injectionSignals,
		...(metadata ?? {}),
		...(extracted.canonicalUrl ? { canonicalUrl: extracted.canonicalUrl } : {}),
		...(title ? { title } : {}),
		markdown,
		links,
		status: result.status,
		...(wasSeed ? { wasSeed: true as const } : {}),
		contentHash: hashContent(markdown),
		extractor: extracted.extractor,
		...(extracted.inlineStateSource
			? { inlineStateSource: extracted.inlineStateSource }
			: {}),
		confidence: quality.confidence,
		qualityReasons: quality.reasons,
		source,
		timings: {
			fetchMs: result.fetchMs,
			extractMs: performance.now() - started,
			writeMs: 0,
		},
	};
}

const titleStopTerms = new Set(["and", "the", "with", "from", "your"]);

function isChromeOnlyHtml(
	markdown: string,
	title: string | undefined,
	extractor: PageExtractor,
	quality: { reasons: string[] },
	links: number,
) {
	if (extractor !== "html") return false;
	if (!quality.reasons.includes("high link density")) return false;
	if (links < 20 || /^#{1,6}\s+/m.test(markdown)) return false;
	const terms = (title ?? "")
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter((term) => term.length >= 4 && !titleStopTerms.has(term));
	if (terms.length < 2) return false;
	const text = markdown.toLowerCase();
	return terms.filter((term) => text.includes(term)).length < 2;
}

export function failedRecord(
	result: FetchResult,
	source: DiscoverySource,
	metadata: FetchedUrl["metadata"],
	error: string,
	failureKind: FailureKind = "extract",
	injectionSignals: PageRecord["injectionSignals"] = [],
	wasSeed?: true,
): PageRecord {
	return {
		ok: false,
		url: result.url,
		finalUrl: result.finalUrl,
		redirects: result.redirects ?? [],
		...(result.etag ? { etag: result.etag } : {}),
		...(result.lastModified ? { lastModified: result.lastModified } : {}),
		fetchedAt: result.fetchedAt ?? new Date().toISOString(),
		injectionSignals,
		...(metadata ?? {}),
		markdown: "",
		links: [],
		status: result.status,
		...(wasSeed ? { wasSeed: true as const } : {}),
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

export function rawInjectionSignals(result: FetchResult) {
	return isMarkdownLike(result)
		? []
		: scanRawHtmlForInjectionSignals(result.body);
}

function uniqueSignals(signals: PageRecord["injectionSignals"]) {
	return [...new Set(signals)];
}
