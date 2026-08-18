import {
	maxGeneratedCapturePages,
	maxGeneratedMediaUrls,
} from "../core/config.ts";
import { markdownImageHrefs, markdownLinkHrefs } from "../core/markdown.ts";
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
import { scanMarkdownForInjectionSignals } from "../security/injection.ts";
import { validatePublicHttpUrl } from "../security/url.ts";
import {
	blockedAccessError,
	isLanguageSelector,
	isLoadingShellPlaceholder,
	reportedNotFoundError,
} from "./app-shell.ts";
import { cleanMarkdown } from "./markdown.ts";
import { scoreMarkdown } from "./quality.ts";
import { titleFromContent } from "./title.ts";

export type ExtractedBody = {
	markdown: string;
	extractor: PageExtractor;
	inlineStateSource?: InlineStateSource;
	title?: string;
	canonicalUrl?: string;
	truncated?: boolean;
	injectionSource?: string;
};

export function recordFromExtracted(
	input: FetchedUrl,
	extracted: ExtractedBody,
	started: number,
	rawSignals: PageRecord["injectionSignals"],
	shell: boolean,
): PageRecord {
	const { metadata, result, source, wasSeed } = input;
	const markdown = cleanMarkdown(extracted.markdown);
	const title = titleFromContent(markdown, extracted.title);
	const emptyError = shell ? shellError : "empty content";
	const fail = (
		error: string,
		failureKind: FailureKind,
		injectionSignals = rawSignals,
	) =>
		failedRecord(
			result,
			source,
			metadata,
			error,
			failureKind,
			injectionSignals,
			wasSeed,
		);
	if (!markdown) return fail(emptyError, "empty");
	if (isLoadingShellPlaceholder(markdown, shell)) {
		return fail(shellError, "empty");
	}
	const reportedNotFound = reportedNotFoundError(markdown, title);
	if (reportedNotFound) {
		return fail(reportedNotFound, "not_found");
	}
	const blocked = blockedAccessError(markdown, title, result.body);
	if (blocked) {
		return fail(blocked, "blocked");
	}
	if (isLanguageSelector(result.finalUrl, result.body)) {
		return fail("language selector without article content", "empty");
	}
	const injectionSignals = uniqueSignals([
		...rawSignals,
		...[...new Set([title, extracted.injectionSource ?? markdown])].flatMap(
			(input) => (input ? scanMarkdownForInjectionSignals(input) : []),
		),
	]);
	const quality = scoreMarkdown(markdown, title);
	if (extracted.truncated) {
		quality.confidence = Math.min(quality.confidence, 0.55);
		quality.reasons.push("truncated extraction");
	}
	const links = publicHrefs(
		markdownLinkHrefs(markdown, maxGeneratedCapturePages),
		result.finalUrl,
		maxGeneratedCapturePages,
	);
	const media = publicHrefs(
		markdownImageHrefs(markdown, maxGeneratedMediaUrls),
		result.finalUrl,
		maxGeneratedMediaUrls,
	);
	if (
		isChromeOnlyContent(
			markdown,
			title,
			extracted.extractor,
			quality,
			links.length,
		)
	) {
		return fail(
			"page chrome without article content",
			"empty",
			injectionSignals,
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
	const page: Extract<PageRecord, { ok: true }> = {
		ok: true,
		url: result.url,
		finalUrl: result.finalUrl,
		redirects: result.redirects ?? [],
		fetchedAt: result.fetchedAt ?? new Date().toISOString(),
		injectionSignals,
		markdown,
		links,
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
	if (result.etag) page.etag = result.etag;
	if (result.lastModified) page.lastModified = result.lastModified;
	if (metadata?.publishedAt) page.publishedAt = metadata.publishedAt;
	if (metadata?.updatedAt) page.updatedAt = metadata.updatedAt;
	if (extracted.canonicalUrl) page.canonicalUrl = extracted.canonicalUrl;
	if (title) page.title = title;
	if (media.length) page.media = media;
	if (wasSeed) page.wasSeed = true;
	if (extracted.inlineStateSource) {
		page.inlineStateSource = extracted.inlineStateSource;
	}
	return page;
}

const shellError = "app shell without static text";

const titleStopTerms = new Set(["and", "the", "with", "from", "your"]);

function isChromeOnlyContent(
	markdown: string,
	title: string | undefined,
	extractor: PageExtractor,
	quality: { reasons: string[] },
	links: number,
) {
	if (title && markdown.replace(/^#{1,6}\s*/, "").trim() === title.trim()) {
		return true;
	}
	if (extractor !== "html") return false;
	if (
		quality.reasons.includes("thin content") &&
		wordCount(markdown) <= 6 &&
		/!\[[^\]]*\]\(|\[[^\]]+\]\(/.test(markdown) &&
		!/[.!?](?:\s|$)/.test(markdown)
	) {
		return true;
	}
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
	const page: Extract<PageRecord, { ok: false }> = {
		ok: false,
		url: result.url,
		finalUrl: result.finalUrl,
		redirects: result.redirects ?? [],
		fetchedAt: result.fetchedAt ?? new Date().toISOString(),
		injectionSignals,
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
	if (result.etag) page.etag = result.etag;
	if (result.lastModified) page.lastModified = result.lastModified;
	if (metadata?.publishedAt) page.publishedAt = metadata.publishedAt;
	if (metadata?.updatedAt) page.updatedAt = metadata.updatedAt;
	if (wasSeed) page.wasSeed = true;
	return page;
}

function uniqueSignals(signals: PageRecord["injectionSignals"]) {
	return [...new Set(signals)];
}

function publicHrefs(hrefs: string[], base: string, limit: number) {
	const links = new Set<string>();
	for (const href of hrefs) {
		try {
			const url = new URL(href, base);
			if (!validatePublicHttpUrl(url.href)) links.add(url.href);
		} catch {
			// Ignore malformed extracted links.
		}
		if (links.size >= limit) break;
	}
	return [...links];
}
