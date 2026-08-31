import { maxGeneratedCapturePages } from "../core/config.ts";
import { hashContent } from "../core/hash.ts";
import { markdownLinkHrefs } from "../core/markdown.ts";
import { wordCount } from "../core/text.ts";
import type {
	DiscoverySource,
	FailureKind,
	FetchedUrl,
	FetchResult,
	PageExtractor,
	PageKind,
	PageRecord,
} from "../core/types.ts";
import { validatePublicHttpUrl } from "../security/url.ts";
import {
	blockedAccessError,
	isLanguageSelector,
	isLoadingShellPlaceholder,
	reportedNotFoundError,
} from "./app-shell.ts";
import { cleanMarkdown } from "./markdown.ts";
import { qualityReasons } from "./quality.ts";
import { titleFromContent } from "./title.ts";

export type ExtractedBody = {
	markdown: string;
	extractor: PageExtractor;
	title?: string;
	canonicalUrl?: string;
	truncated?: boolean;
};

export function recordFromExtracted(
	input: FetchedUrl,
	extracted: ExtractedBody,
	kind: PageKind,
): PageRecord {
	const { result, source, wasSeed } = input;
	const markdown = cleanMarkdown(extracted.markdown);
	const title = titleFromContent(markdown, extracted.title);
	const shell = kind === "app-shell";
	const emptyError = shell ? shellError : "empty content";
	const fail = (error: string, failureKind: FailureKind) =>
		failedRecord(result, source, error, failureKind, wasSeed);
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
	const quality = qualityReasons(markdown, title);
	if (extracted.extractor === "inline-state") {
		quality.push("inline state may omit content");
	}
	if (extracted.truncated) {
		quality.push("truncated extraction");
	}
	const links = publicHrefs(
		markdownLinkHrefs(markdown, maxGeneratedCapturePages),
		result.finalUrl,
		maxGeneratedCapturePages,
	);
	if (
		isChromeOnlyContent(
			markdown,
			title,
			extracted.extractor,
			{ reasons: quality },
			links.length,
		)
	) {
		return fail("page chrome without article content", "empty");
	}
	const page: Extract<PageRecord, { ok: true }> = {
		ok: true,
		url: result.url,
		finalUrl: result.finalUrl,
		redirects: result.redirects ?? [],
		fetchedAt: result.fetchedAt ?? new Date().toISOString(),
		markdown,
		links,
		status: result.status,
		contentHash: hashContent(markdown),
		extractor: extracted.extractor,
		qualityReasons: quality,
		source,
	};
	if (result.etag) page.etag = result.etag;
	if (result.lastModified) page.lastModified = result.lastModified;
	if (extracted.canonicalUrl) page.canonicalUrl = extracted.canonicalUrl;
	if (title) page.title = title;
	if (wasSeed) page.wasSeed = true;
	page.kind = kind;
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
	if (
		extractor === "html" &&
		title &&
		markdown.replace(/^#{1,6}\s*/, "").trim() === title.trim()
	) {
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
	if (links <= Math.max(20, wordCount(markdown) / 8)) return false;
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
	error: string,
	failureKind: FailureKind = "extract",
	wasSeed?: true,
): PageRecord {
	const page: Extract<PageRecord, { ok: false }> = {
		ok: false,
		url: result.url,
		finalUrl: result.finalUrl,
		redirects: result.redirects ?? [],
		fetchedAt: result.fetchedAt ?? new Date().toISOString(),
		markdown: "",
		links: [],
		status: result.status,
		contentHash: "",
		extractor: "none",
		qualityReasons: [],
		source,
		error,
		failureKind,
	};
	if (result.etag) page.etag = result.etag;
	if (result.lastModified) page.lastModified = result.lastModified;
	if (wasSeed) page.wasSeed = true;
	return page;
}

function publicHrefs(hrefs: string[], base: string, limit: number) {
	const links = new Set<string>();
	for (const href of hrefs) {
		try {
			const url = new URL(href, base);
			if (!validatePublicHttpUrl(url.href)) links.add(url.href);
		} catch {}
		if (links.size >= limit) break;
	}
	return [...links];
}
