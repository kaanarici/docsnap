export const discoverySources = [
	"seed",
	"llms",
	"sitemap",
	"feed",
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
		case "feed":
			return 4;
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

export const inlineStateSources = [
	"next-data",
	"rsc",
	"nuxt",
	"remix",
	"redux",
	"ld-json",
	"json",
] as const;

export type InlineStateSource = (typeof inlineStateSources)[number];

export const failureKinds = [
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

export const injectionSignals = [
	"zero-width-text",
	"unicode-tag-text",
	"bidi-control",
	"mixed-script-confusable",
	"hidden-html-text",
	"html-comment-instruction",
	"instruction-override",
	"fake-system-turn",
	"ai-directed-instruction",
	"tool-exfiltration-language",
	"unsafe-link-scheme",
	"encoded-injection-blob",
	"opaque-encoded-blob",
] as const;

export type InjectionSignal = (typeof injectionSignals)[number];

export function filterInjectionSignals(
	value: import("./json.ts").JsonValue | undefined,
): InjectionSignal[] {
	return Array.isArray(value)
		? value.filter(
				(item): item is InjectionSignal =>
					typeof item === "string" &&
					injectionSignals.some((signal) => signal === item),
			)
		: [];
}

export const lowQualityConfidence = 0.6;

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
	dryRun: boolean;
	pageOnly: boolean;
	cache: boolean;
	userAgent: string;
	timeoutMs: number;
	maxBytes: number;
	topic?: string;
};

export type CliOptions = {
	json: boolean;
	quiet: boolean;
	failOnLowQuality: boolean;
	failOnInjectionSignal: boolean;
};

type FetchBase = {
	url: string;
	finalUrl: string;
	status: number;
	contentType: string;
	body: string;
	document?: Uint8Array;
	fetchMs: number;
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
		| { ok: false; error: string; failureKind: FailureKind }
	);

export type ConditionalRequest = {
	etag?: string;
	lastModified?: string;
	urls: string[];
};

export type DiscoveryMetadata = {
	publishedAt?: string;
	updatedAt?: string;
};

export type DiscoveryResourceSeed = {
	url: string;
	finalUrl: string;
	source: Extract<DiscoverySource, "feed" | "llms">;
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

type RenderMetrics = {
	renderer: "chrome-cdp";
	renderMs: number;
	blockedRequests: number;
	fulfilledRequests: number;
	relayedBytes: number;
};

type PageBase = {
	url: string;
	finalUrl: string;
	status: number;
	source: DiscoverySource;
	wasSeed?: true;
	timings: { fetchMs: number; extractMs: number; writeMs: number };
	redirects: RedirectHop[];
	etag?: string;
	lastModified?: string;
	fetchedAt: string;
	injectionSignals: InjectionSignal[];
	render?: RenderMetrics & { truncated?: true };
	publishedAt?: string;
	updatedAt?: string;
};

export type PageSuccess = PageBase & {
	ok: true;
	canonicalUrl?: string;
	aliases?: string[];
	title?: string;
	markdown: string;
	links: string[];
	media?: string[];
	contentHash: string;
	extractor: PageExtractor;
	inlineStateSource?: InlineStateSource;
	confidence: number;
	qualityReasons: string[];
};

export type PathedPage = PageSuccess & { outputPath: string };

export type PageOutput = PathedPage & { rendered: string; outputHash: string };

export type PageFailure = PageBase & {
	ok: false;
	markdown: "";
	links: [];
	media?: string[];
	contentHash: "";
	extractor: "none";
	confidence: 0;
	qualityReasons: [];
	error: string;
	failureKind: FailureKind;
};

export type PageRecord = PageSuccess | PageFailure;

export type RunRecord = PageOutput | PageFailure;

export type RunSummary = {
	status: "ok" | "partial" | "failed";
	seedUrl: string;
	seed: SeedSummary;
	warnings: RunWarning[];
	outDir: string;
	dryRun: boolean;
	captureMode: "page" | "site";
	userAgent: string;
	generatedAt: string;
	snapshotVersion: number;
	rootHash: string;
	corpusFiles: number;
	corpusBytes: number;
	max: number;
	maxAppliesTo: "all" | "non-llms";
	maxReached: boolean;
	discoveryTruncated?: boolean;
	selectionHash?: string;
	discovered: number;
	deduped: number;
	written: number;
	failed: number;
	lowQuality: number;
	qualityWarnings: number;
	injectionSignalPages: number;
	byInjectionSignal: Partial<Record<InjectionSignal, number>>;
	hostRedirects: number;
	redirectedHosts: Array<{ from: string; to: string; count: number }>;
	elapsedMs: number;
	firstPageMs: number | null;
	pagesPerSecond: number;
	bySource: Record<DiscoverySource, number>;
	byExtractor: Record<PageExtractor, number>;
	byInlineStateSource: Partial<Record<InlineStateSource, number>>;
	byFailureKind: Partial<Record<FailureKind, number>>;
	errors: Array<{ url: string; error: string; kind: FailureKind }>;
	render?: RenderMetrics & {
		attempted: number;
		rendered: number;
		recovered: number;
		failed: number;
		launchMs: number;
		skipped: number;
		truncated: boolean;
		stopReason?: "budget" | "no_recovery";
		unavailable?: string;
	};
	refresh: RefreshSummary;
	cache: CacheSummary;
};

export function runSucceeded(
	summary: Pick<RunSummary, "captureMode" | "written" | "seed">,
) {
	return (
		summary.written > 0 &&
		(summary.captureMode === "site" || summary.seed.included)
	);
}

export type RunWarning =
	| {
			kind: "seed_omitted" | "discovery_resource_empty";
			message: string;
			omissionReason?: SeedSummary["omissionReason"];
			failureKind?: FailureKind;
			error?: string;
	  }
	| {
			kind: "discovery_resource_seed";
			message: string;
			source?: DiscoverySource;
			pagesWritten: number;
	  }
	| {
			kind: "seed_redirected";
			message: string;
			url?: string;
			finalUrl?: string;
	  };

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

export type CacheSummary = {
	enabled: boolean;
	dir: string | null;
	hits: number;
	misses: number;
	stale: number;
	revalidated: number;
	written: number;
	notStored: number;
	bytesRead: number;
	bytesWritten: number;
	evictedBytes: number;
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
	reason?: "clean" | "missing_manifest" | "invalid_manifest";
	priorRecords: number;
	checked: number;
	notModified: number;
	reused: number;
	fallbackRefetches: number;
	pageWrites: number;
	skippedWrites: number;
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
