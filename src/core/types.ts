export const discoverySources = [
	"seed",
	"llms",
	"sitemap",
	"feed",
	"nav",
	"crawl",
	"asset",
] as const;

export type DiscoverySource = (typeof discoverySources)[number];

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
	"encoded-injection-blob",
	"opaque-encoded-blob",
] as const;

export type InjectionSignal = (typeof injectionSignals)[number];

export const lowQualityConfidence = 0.6;

export type RunStatus = "ok" | "partial" | "failed";
export type MaxAppliesTo = "all" | "non-llms";

export type Config = {
	seedUrl: string;
	outDir: string;
	max: number;
	maxExplicit: boolean;
	concurrency: number;
	perOrigin: number;
	clean: boolean;
	dryRun: boolean;
	agentFiles: boolean;
	pageOnly: boolean;
	ignoreRobots: boolean;
	userAgent: string;
	timeoutMs: number;
	retryHttp?: boolean;
	maxBytes: number;
	failOnLowQuality: boolean;
	failOnInjectionSignal: boolean;
	json: boolean;
	quiet: boolean;
};

type FetchBase = {
	url: string;
	finalUrl: string;
	status: number;
	contentType: string;
	body: string;
	fetchMs: number;
	redirects?: RedirectHop[];
	etag?: string;
	lastModified?: string;
	fetchedAt?: string;
};

export type RedirectHop = {
	from: string;
	to: string;
	type: "http" | "refresh";
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

export type DiscoveredUrl = {
	url: string;
	source: DiscoverySource;
	fetched?: FetchResult;
	metadata?: DiscoveryMetadata;
};

export type FetchedUrl = {
	source: DiscoverySource;
	result: FetchResult;
	metadata?: DiscoveryMetadata;
};

type PageTimings = {
	fetchMs: number;
	extractMs: number;
	writeMs: number;
};

type PageBase = {
	url: string;
	finalUrl: string;
	status: number;
	source: DiscoverySource;
	timings: PageTimings;
	redirects: RedirectHop[];
	etag?: string;
	lastModified?: string;
	fetchedAt: string;
	injectionSignals: InjectionSignal[];
	publishedAt?: string;
	updatedAt?: string;
};

export type PageExtractor = "markdown" | "html" | "text" | "fallback";

export type PageSuccess = PageBase & {
	ok: true;
	canonicalUrl?: string;
	aliases?: string[];
	title?: string;
	markdown: string;
	links: string[];
	contentHash: string;
	extractor: PageExtractor;
	confidence: number;
	qualityReasons: string[];
	outputPath?: string;
};

export type PageOutput = PageSuccess & { outputPath: string };

export type PageFailure = PageBase & {
	ok: false;
	markdown: "";
	links: [];
	contentHash: "";
	extractor: "none";
	confidence: 0;
	qualityReasons: [];
	error: string;
	failureKind: FailureKind;
};

export type PageRecord = PageSuccess | PageFailure;

export type RunSummary = {
	status: RunStatus;
	seedUrl: string;
	outDir: string;
	dryRun: boolean;
	userAgent: string;
	ignoreRobots?: true;
	generatedAt: string;
	snapshotVersion: number;
	rootHash: string;
	renderedFiles: number;
	renderedBytes: number;
	max: number;
	maxAppliesTo: MaxAppliesTo;
	maxReached: boolean;
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
	pagesPerSecond: number;
	bySource: Record<DiscoverySource, number>;
	byFailureKind: Partial<Record<FailureKind, number>>;
	errors: Array<{ url: string; error: string; kind: FailureKind }>;
	refresh: RefreshSummary;
	agentFilesUpdated?: string[];
};

export type RefreshChange = "new" | "changed" | "unchanged" | "removed";

export type RefreshChangedPage = {
	change: RefreshChange;
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
	skippedWrites: number;
	new: number;
	changed: number;
	unchanged: number;
	removed: number;
	changedPages: RefreshChangedPage[];
};

export type PipelineResult = {
	records: PageRecord[];
	summary: RunSummary;
};
