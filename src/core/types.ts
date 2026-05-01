export const discoverySources = [
	"seed",
	"llms",
	"sitemap",
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
};

export type FetchResult = FetchBase &
	(
		| { ok: true; error?: never; failureKind?: never }
		| { ok: false; error: string; failureKind: FailureKind }
	);

export type DiscoveredUrl = {
	url: string;
	source: DiscoverySource;
	fetched?: FetchResult;
};

export type FetchedUrl = {
	source: DiscoverySource;
	result: FetchResult;
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
	elapsedMs: number;
	pagesPerSecond: number;
	bySource: Record<DiscoverySource, number>;
	byFailureKind: Partial<Record<FailureKind, number>>;
	errors: Array<{ url: string; error: string; kind: FailureKind }>;
};

export type PipelineResult = {
	records: PageRecord[];
	summary: RunSummary;
};
