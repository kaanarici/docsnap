import { resolveSafeRelativePath } from "../core/fs-safety.ts";
import {
	identityKeyGroups,
	type identityKeys,
	identityUrls,
} from "../core/identity.ts";
import {
	isJsonNumber,
	isJsonObject,
	isJsonString,
	type JsonValue,
	jsonEnum,
	parseJsonValue,
} from "../core/json.ts";
import { hashContent } from "../core/snapshot.ts";
import type {
	ConditionalRequest,
	PageSuccess,
	PipelineConfig,
	RedirectHop,
} from "../core/types.ts";
import {
	discoverySources,
	filterInjectionSignals,
	inlineStateSources,
	pageExtractors,
} from "../core/types.ts";
import { corpusLimits, readBoundedCorpusFile } from "../corpus/access.ts";
import { scanMarkdownForInjectionSignals } from "../security/injection.ts";
import { runFiles } from "./files.ts";

export type PriorPage = Omit<
	PageSuccess,
	"fetchedAt" | "links" | "markdown" | "media" | "rendered" | "timings"
> & {
	outputPath: string;
	fetchedAt?: string;
	outputHash?: string;
	links?: string[];
	linksCount?: number;
	linksTruncated?: true;
	media?: string[];
};

export type PriorState = {
	enabled: boolean;
	reason?: "clean" | "missing_manifest" | "invalid_manifest";
	records: PriorPage[];
	find(input: Parameters<typeof identityKeys>[0]): PriorPage | undefined;
};

type OutputRoot = { outDir: string };

export function resolvePriorOutputPath(
	config: OutputRoot,
	outputPath: string,
): string | undefined {
	return resolveSafeRelativePath(config.outDir, outputPath);
}

export async function loadPrior(config: PipelineConfig): Promise<PriorState> {
	if (config.clean) return disabled("clean");
	try {
		const [text, summaryText] = await Promise.all([
			readBoundedCorpusFile(
				config.outDir,
				runFiles.manifest,
				corpusLimits.manifestBytes,
			),
			readBoundedCorpusFile(
				config.outDir,
				runFiles.summary,
				corpusLimits.summaryBytes,
			),
		]);
		const records = parsePriorManifest(text, config);
		if (!priorMatchesSummary(summaryText, records, config.seedUrl)) {
			throw new Error("manifest and summary disagree");
		}
		return enabled(records);
	} catch (error) {
		if (
			error instanceof Error &&
			(error.message === "output_dir does not exist" ||
				error.message.startsWith("Corpus file not found:"))
		) {
			return disabled("missing_manifest");
		}
		return disabled("invalid_manifest");
	}
}

export function conditionalRequestForPrior(
	prior: PriorState,
	input: Parameters<typeof identityKeys>[0],
): ConditionalRequest | undefined {
	if (!prior.enabled) return undefined;
	const record = prior.find(input);
	if (
		!record ||
		record.render ||
		record.linksTruncated ||
		(record.linksCount ?? 0) > (record.links?.length ?? 0) ||
		(!record.etag && !record.lastModified)
	) {
		return undefined;
	}
	const request: ConditionalRequest = {
		urls: identityUrls(record),
	};
	if (record.etag) request.etag = record.etag;
	if (record.lastModified) request.lastModified = record.lastModified;
	return request;
}

export async function recoverPriorPage(
	config: PipelineConfig,
	prior: PriorPage,
	updates: {
		fetchMs: number;
		etag?: string;
		lastModified?: string;
		fetchedAt?: string;
	},
): Promise<PageSuccess | undefined> {
	const rendered = await readPriorOutput(config, prior.outputPath);
	if (!rendered) return undefined;
	if (prior.outputHash && hashContent(rendered) !== prior.outputHash) {
		return undefined;
	}
	const markdown = markdownFromRendered(rendered);
	if (hashContent(markdown) !== prior.contentHash) return undefined;
	const { linksCount, linksTruncated, outputHash, ...record } = prior;
	void linksCount;
	void linksTruncated;
	void outputHash;
	const recoveredSignals = filterInjectionSignals([
		...record.injectionSignals,
		...scanMarkdownForInjectionSignals(markdown),
	]);
	const recovered: PageSuccess = {
		...record,
		links: record.links ?? [],
		injectionSignals: recoveredSignals,
		markdown,
		fetchedAt:
			record.fetchedAt ?? updates.fetchedAt ?? new Date().toISOString(),
		timings: {
			fetchMs: updates.fetchMs,
			extractMs: 0,
			writeMs: 0,
		},
	};
	if (updates.etag) recovered.etag = updates.etag;
	if (updates.lastModified) recovered.lastModified = updates.lastModified;
	return recovered;
}

export async function readPriorOutput(
	config: OutputRoot,
	outputPath: string,
): Promise<string | undefined> {
	try {
		return await readBoundedCorpusFile(
			config.outDir,
			outputPath,
			corpusLimits.pageBytes,
		);
	} catch {
		return undefined;
	}
}

function enabled(records: PriorPage[]): PriorState {
	const index = buildIndex(records);
	return {
		enabled: true,
		records,
		find: (input) => findPrior(index, input),
	};
}

function disabled(reason: NonNullable<PriorState["reason"]>): PriorState {
	return {
		enabled: false,
		reason,
		records: [],
		find: () => undefined,
	};
}

function parsePriorManifest(text: string, config: PipelineConfig): PriorPage[] {
	const lines = text.split(/\n/).filter((line) => line.trim());
	const pages: PriorPage[] = [];
	const outputPaths = new Set<string>();
	for (const line of lines) {
		const record = parseReusablePrior(parseJsonValue(line), config);
		if (!record) continue;
		if (outputPaths.has(record.outputPath)) {
			throw new Error("duplicate manifest output path");
		}
		outputPaths.add(record.outputPath);
		pages.push(record);
	}
	return pages;
}

function priorMatchesSummary(
	summaryText: string,
	records: PriorPage[],
	seedUrl: string,
): boolean {
	const summary = parseJsonValue(summaryText);
	if (
		!isJsonObject(summary) ||
		!isJsonNumber(summary["written"]) ||
		summary["written"] !== records.length ||
		summary["seedUrl"] !== seedUrl
	)
		return false;
	const seed = summary["seed"];
	const seedPath = isJsonObject(seed) ? seed["outputPath"] : undefined;
	return (
		!isJsonString(seedPath) ||
		records.some((record) => record.outputPath === seedPath)
	);
}

export function parseReusablePrior(
	value: JsonValue,
	config: OutputRoot,
): PriorPage | undefined {
	if (!isJsonObject(value) || value["ok"] !== true) return undefined;
	const source =
		value["source"] === "asset"
			? "crawl"
			: jsonEnum(value["source"], discoverySources);
	const extractor = jsonEnum(value["extractor"], pageExtractors);
	const redirects =
		value["redirects"] === undefined ? [] : parseRedirects(value["redirects"]);
	if (
		!isJsonString(value["url"]) ||
		!isJsonString(value["finalUrl"]) ||
		!isJsonString(value["outputPath"]) ||
		resolveSafeRelativePath(config.outDir, value["outputPath"]) === undefined ||
		!isJsonString(value["contentHash"]) ||
		!isJsonNumber(value["status"]) ||
		!isJsonNumber(value["confidence"]) ||
		!source ||
		!extractor ||
		!redirects
	) {
		return undefined;
	}
	const record: PriorPage = {
		ok: true,
		url: value["url"],
		finalUrl: value["finalUrl"],
		outputPath: value["outputPath"],
		contentHash: value["contentHash"],
		status: value["status"],
		confidence: value["confidence"],
		source,
		extractor,
		redirects,
		injectionSignals: filterInjectionSignals(value["injectionSignals"]),
		qualityReasons: stringArray(value["qualityReasons"]) ?? [],
	};
	if (isJsonString(value["fetchedAt"])) record.fetchedAt = value["fetchedAt"];
	if (value["wasSeed"] === true) record.wasSeed = true;
	if (value["linksTruncated"] === true) record.linksTruncated = true;
	if (isJsonNumber(value["linksCount"]))
		record.linksCount = value["linksCount"];
	for (const key of [
		"outputHash",
		"canonicalUrl",
		"title",
		"etag",
		"lastModified",
		"publishedAt",
		"updatedAt",
	] as const) {
		const item = value[key];
		if (isJsonString(item)) record[key] = item;
	}
	for (const key of ["aliases", "links", "media"] as const) {
		const items = stringArray(value[key]);
		if (items) record[key] = items;
	}
	const inlineStateSource = jsonEnum(
		value["inlineStateSource"],
		inlineStateSources,
	);
	if (inlineStateSource) record.inlineStateSource = inlineStateSource;
	if (value["render"] !== undefined) {
		const render = parseRender(value["render"]);
		if (!render) return undefined;
		record.render = render;
	}
	return record;
}

function parseRedirects(
	value: JsonValue | undefined,
): RedirectHop[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const redirects = value.map(parseRedirect);
	if (redirects.some((redirect) => redirect === undefined)) return undefined;
	return redirects.filter(
		(redirect): redirect is RedirectHop => redirect !== undefined,
	);
}

function parseRedirect(value: JsonValue): RedirectHop | undefined {
	if (
		!isJsonObject(value) ||
		!isJsonString(value["from"]) ||
		!isJsonString(value["to"]) ||
		(value["type"] !== "http" &&
			value["type"] !== "refresh" &&
			value["type"] !== "client") ||
		(value["status"] !== undefined && !isJsonNumber(value["status"]))
	) {
		return undefined;
	}
	const redirect: RedirectHop = {
		from: value["from"],
		to: value["to"],
		type: value["type"],
	};
	if (isJsonNumber(value["status"])) redirect.status = value["status"];
	return redirect;
}

function parseRender(
	value: JsonValue | undefined,
): NonNullable<PriorPage["render"]> | undefined {
	if (
		!isJsonObject(value) ||
		value["renderer"] !== "chrome-cdp" ||
		!isJsonNumber(value["renderMs"]) ||
		!isJsonNumber(value["blockedRequests"]) ||
		!isJsonNumber(value["fulfilledRequests"]) ||
		!isJsonNumber(value["relayedBytes"]) ||
		(value["truncated"] !== undefined && value["truncated"] !== true)
	) {
		return undefined;
	}
	const render: NonNullable<PriorPage["render"]> = {
		renderer: "chrome-cdp",
		renderMs: value["renderMs"],
		blockedRequests: value["blockedRequests"],
		fulfilledRequests: value["fulfilledRequests"],
		relayedBytes: value["relayedBytes"],
	};
	if (value["truncated"] === true) render.truncated = true;
	return render;
}

function stringArray(value: JsonValue | undefined): string[] | undefined {
	return Array.isArray(value) && value.every(isJsonString) ? value : undefined;
}

function buildIndex(records: PriorPage[]) {
	const exact = new Map<string, PriorPage>();
	const route = new Map<string, PriorPage>();
	const ambiguousExact = new Set<string>();
	const ambiguousRoute = new Set<string>();
	for (const record of records) {
		const keys = identityKeyGroups(record);
		for (const key of keys.exact) indexPage(exact, ambiguousExact, key, record);
		for (const key of keys.route) indexPage(route, ambiguousRoute, key, record);
	}
	return { exact, route };
}

function indexPage(
	index: Map<string, PriorPage>,
	ambiguous: Set<string>,
	key: string,
	record: PriorPage,
) {
	if (ambiguous.has(key)) return;
	const existing = index.get(key);
	if (!existing) index.set(key, record);
	else if (existing !== record) {
		index.delete(key);
		ambiguous.add(key);
	}
}

function findPrior(
	index: ReturnType<typeof buildIndex>,
	input: Parameters<typeof identityKeys>[0],
): PriorPage | undefined {
	const keys = identityKeyGroups(input);
	for (const key of keys.exact) {
		const record = index.exact.get(key);
		if (record) return record;
	}
	for (const key of keys.route) {
		const record = index.route.get(key);
		if (record) return record;
	}
	return undefined;
}

export function markdownFromRendered(rendered: string): string {
	let markdown = rendered;
	if (!rendered.startsWith("---\n")) {
		return rendered.endsWith("\n") ? rendered.slice(0, -1) : rendered;
	}
	const end = rendered.indexOf("\n---\n", 4);
	if (end >= 0) markdown = rendered.slice(end + 5);
	return markdown.endsWith("\n") ? markdown.slice(0, -1) : markdown;
}
