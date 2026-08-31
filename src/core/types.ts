export const discoverySources = [
	"seed",
	"llms",
	"sitemap",
	"nav",
	"crawl",
] as const;

export type DiscoverySource = (typeof discoverySources)[number];
export function discoverySourceScore(source: DiscoverySource): number {
	switch (source) {
		case "llms":
			return 7;
		case "sitemap":
			return 5;
		case "nav":
			return 3;
		case "crawl":
			return 2;
		case "seed":
			return 1;
	}
}

export const pageExtractors = [
	"markdown",
	"html",
	"text",
	"fallback",
	"structured",
	"inline-state",
] as const;

export type PageExtractor = (typeof pageExtractors)[number];

export const pageKinds = [
	"markdown",
	"docs-html",
	"article-html",
	"app-shell",
	"binary",
	"feed",
	"empty",
	"blocked",
] as const;

export type PageKind = (typeof pageKinds)[number];

export const byteSources = ["http", "chrome"] as const;

type ByteSource = (typeof byteSources)[number];

const failureKinds = [
	"blocked",
	"empty",
	"extract",
	"fetch",
	"http",
	"not_found",
	"timeout",
	"too_large",
	"unsafe_url",
] as const;

export type FailureKind = (typeof failureKinds)[number];

export function failureCanRetry(
	cause: FailureKind | "rate_limited" | undefined,
): boolean {
	return cause === "timeout" || cause === "fetch" || cause === "rate_limited";
}

export type HeaderMap = {
	get(name: string): string | null;
	getSetCookie?(): string[];
	entries(): IterableIterator<[string, string]>;
};

export type HttpResponse = {
	url: string;
	status: number;
	headers: HeaderMap;
	body: Uint8Array;
};

export type PipelineConfig = {
	seedUrl: string;
	outDir: string;
	max: number;
	maxExplicit: boolean;
	concurrency: number;
	perOrigin: number;
	clean: boolean;
	pageOnly: boolean;
	cache: boolean;
	include: string[];
	exclude: string[];
	userAgent: string;
	timeoutMs: number;
	maxBytes: number;
	signal?: AbortSignal;
};

type FetchBase = {
	url: string;
	finalUrl: string;
	status: number;
	contentType: string;
	body: string;
	document?: Uint8Array;
	redirects?: RedirectHop[];
	etag?: string;
	lastModified?: string;
	fetchedAt?: string;
	cacheControl?: string;
	ageSeconds?: number;
	vary?: string;
	setCookie?: boolean;
};

export type RedirectHop = {
	from: string;
	to: string;
	type: "http" | "refresh" | "client";
	status?: number;
};

export type FetchResult = FetchBase &
	(
		| { ok: true; notModified?: false; error?: never; failureKind?: never }
		| {
				ok: true;
				notModified: true;
				status: 304;
				body: "";
				error?: never;
				failureKind?: never;
		  }
		| {
				ok: false;
				error: string;
				failureKind: FailureKind;
				retryAt?: string;
		  }
	);

export type ConditionalRequest = {
	etag?: string;
	lastModified?: string;
	urls: string[];
};

type DiscoveryMetadata = {
	publishedAt?: string;
	updatedAt?: string;
};

export type DiscoveryResourceSeed = {
	url: string;
	finalUrl: string;
	source: Extract<DiscoverySource, "llms">;
};

export type DiscoveredUrl = {
	url: string;
	source: DiscoverySource;
	wasSeed?: true;
	fetched?: FetchResult;
	metadata?: DiscoveryMetadata;
};

export type FetchedUrl = {
	source: DiscoverySource;
	wasSeed?: true;
	result: FetchResult;
	metadata?: DiscoveryMetadata;
};

type PageBase = {
	url: string;
	finalUrl: string;
	status: number;
	source: DiscoverySource;
	wasSeed?: true;
	redirects: RedirectHop[];
	etag?: string;
	lastModified?: string;
	fetchedAt: string;
};

export type PageSuccess = PageBase & {
	ok: true;
	canonicalUrl?: string;
	aliases?: string[];
	title?: string;
	markdown: string;
	links: string[];
	contentHash: string;
	extractor: PageExtractor;
	kind?: PageKind;
	byteSource?: ByteSource;
	qualityReasons: string[];
};

export type PathedPage = PageSuccess & { outputPath: string };

export type PageOutput = PathedPage & { rendered: string; outputHash: string };

export type PageFailure = PageBase & {
	ok: false;
	markdown: "";
	links: [];
	contentHash: "";
	extractor: "none";
	qualityReasons: [];
	error: string;
	failureKind: FailureKind;
};

export type PageRecord = PageSuccess | PageFailure;

export type RunRecord = PageOutput | PageFailure;

export type RunSummary = {
	ok: boolean;
	generator: string;
	seedUrl: string;
	seed: SeedSummary;
	outDir: string;
	captureMode: "page" | "site";
	userAgent: string;
	include?: string[];
	exclude?: string[];
	generatedAt: string;
	max: number;
	maxAppliesTo: "all" | "non-llms";
	maxReached: boolean;
	discoveryTruncated?: boolean;
	stopReason?: "rate_limited";
	retryAt?: string;
	written: number;
	failed: number;
	lowQuality: number;
	qualityWarnings: number;
	byFailureKind: Partial<Record<FailureKind, number>>;
	errors: Array<{ url: string; error: string; failureKind: FailureKind }>;
	errorsOmitted?: number;
	render?: {
		recovered: number;
		failed: number;
		skipped: number;
		truncated: boolean;
		stopReason?: "budget" | "no_recovery";
		unavailable?: string;
	};
	refresh?: RefreshSummary;
};

export function runSucceeded(
	summary: Pick<
		RunSummary,
		"ok" | "captureMode" | "written" | "seed" | "stopReason"
	>,
) {
	return (
		summary.ok &&
		!summary.stopReason &&
		summary.written > 0 &&
		(summary.captureMode === "site" || summary.seed.included)
	);
}

export type SeedSummary = {
	attempted: boolean;
	included: boolean;
	url?: string;
	finalUrl?: string;
	redirected?: true;
	source?: DiscoverySource;
	kind?: "page" | "discovery_resource";
	outputPath?: string;
	pagesWritten?: number;
	omissionReason?:
		| "not_discovered"
		| "failed"
		| "not_written"
		| "empty_resource";
	failureKind?: FailureKind;
	error?: string;
};

export type RefreshChangedPage = {
	change: "new" | "changed" | "removed";
	url: string;
	finalUrl?: string;
	outputPath?: string;
	previousOutputPath?: string;
};

export type RefreshSummary = {
	enabled: boolean;
	reason?: "clean" | "missing_manifest" | "invalid_manifest" | "seed_mismatch";
	new: number;
	changed: number;
	unchanged: number;
	removed: number;
	changedPages: RefreshChangedPage[];
};

export type PipelineResult = {
	records: RunRecord[];
	summary: RunSummary;
};
