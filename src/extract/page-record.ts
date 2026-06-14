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
	emptyContentError,
	isBlockedChallenge,
	isLanguageSelector,
	isLoadingShellPlaceholder,
} from "./app-shell.ts";
import { cleanMarkdown, linksFromMarkdown } from "./markdown.ts";
import { scoreMarkdown } from "./quality.ts";

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
	rawInjectionSignals: PageRecord["injectionSignals"],
): PageRecord {
	const { metadata, result, source } = input;
	const markdown = cleanMarkdown(extracted.markdown);
	if (!markdown)
		return failedRecord(
			result,
			source,
			metadata,
			emptyContentError(result.body),
			"empty",
			rawInjectionSignals,
		);
	if (isLoadingShellPlaceholder(markdown, result.body)) {
		return failedRecord(
			result,
			source,
			metadata,
			"app shell without static text",
			"empty",
			rawInjectionSignals,
		);
	}
	if (isBlockedChallenge(markdown, extracted.title)) {
		return failedRecord(
			result,
			source,
			metadata,
			"blocked by client challenge",
			"blocked",
			rawInjectionSignals,
		);
	}
	if (isLanguageSelector(result.finalUrl, result.body)) {
		return failedRecord(
			result,
			source,
			metadata,
			"language selector without article content",
			"empty",
			rawInjectionSignals,
		);
	}
	const injectionSignals = uniqueSignals([
		...rawInjectionSignals,
		...scanMarkdownForInjectionSignals(markdown),
	]);
	const quality = scoreMarkdown(markdown, extracted.title);
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
		...(extracted.title ? { title: extracted.title } : {}),
		markdown,
		links: linksFromMarkdown(markdown),
		status: result.status,
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

export function failedRecord(
	result: FetchResult,
	source: DiscoverySource,
	metadata: FetchedUrl["metadata"],
	error: string,
	failureKind: FailureKind = "extract",
	injectionSignals: PageRecord["injectionSignals"] = [],
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
	return scanRawHtmlForInjectionSignals(result.body);
}

function uniqueSignals(signals: PageRecord["injectionSignals"]) {
	return [...new Set(signals)];
}
