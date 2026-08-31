import { resolveSafeRelativePath } from "../core/fs-safety.ts";
import { hashContent } from "../core/hash.ts";
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
import type {
	ConditionalRequest,
	PageSuccess,
	PipelineConfig,
	RedirectHop,
} from "../core/types.ts";
import {
	byteSources,
	discoverySources,
	pageExtractors,
	pageKinds,
} from "../core/types.ts";
import { corpusGenerator, runFiles } from "./files.ts";
import { corpusLimits, readBoundedCorpusFile } from "./read.ts";

export type PriorPage = Omit<
	PageSuccess,
	"fetchedAt" | "links" | "markdown" | "rendered"
> & {
	outputPath: string;
	fetchedAt?: string;
	outputHash?: string;
	links?: string[];
	linksCount?: number;
	linksTruncated?: true;
};

export type PriorState = {
	enabled: boolean;
	reuseGenerated: boolean;
	reason?: "clean" | "missing_manifest" | "invalid_manifest" | "seed_mismatch";
	seedUrl?: string;
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
		const manifest = parsePriorManifest(text, config);
		const summary = parseJsonValue(summaryText);
		const summarySeed =
			isJsonObject(summary) && isJsonString(summary["seedUrl"])
				? summary["seedUrl"]
				: undefined;
		if (summarySeed && summarySeed !== config.seedUrl) {
			return disabled("seed_mismatch", summarySeed);
		}
		if (!priorMatchesSummary(summary, manifest.records, config.seedUrl)) {
			throw new Error("manifest and summary disagree");
		}
		return enabled(
			manifest.records,
			isJsonObject(summary) && summary["generator"] === corpusGenerator,
		);
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
	if (!prior.enabled || !prior.reuseGenerated) return undefined;
	const record = prior.find(input);
	if (
		!record ||
		record.byteSource === "chrome" ||
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
	const recovered: PageSuccess = {
		...record,
		links: record.links ?? [],
		markdown,
		fetchedAt:
			record.fetchedAt ?? updates.fetchedAt ?? new Date().toISOString(),
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

function enabled(records: PriorPage[], reuseGenerated: boolean): PriorState {
	const index = buildIndex(records);
	return {
		enabled: true,
		reuseGenerated,
		records,
		find: (input) => findPrior(index, input),
	};
}

function disabled(
	reason: NonNullable<PriorState["reason"]>,
	seedUrl?: string,
): PriorState {
	const prior: PriorState = {
		enabled: false,
		reuseGenerated: false,
		reason,
		records: [],
		find: () => undefined,
	};
	if (seedUrl) prior.seedUrl = seedUrl;
	return prior;
}

function parsePriorManifest(text: string, config: PipelineConfig) {
	const lines = text.split(/\n/).filter((line) => line.trim());
	const pages: PriorPage[] = [];
	const outputPaths = new Set<string>();
	for (const line of lines) {
		const value = parseJsonValue(line);
		const record = parseReusablePrior(value, config);
		if (!record) continue;
		if (outputPaths.has(record.outputPath)) {
			throw new Error("duplicate manifest output path");
		}
		outputPaths.add(record.outputPath);
		pages.push(record);
	}
	return { records: pages };
}

function priorMatchesSummary(
	summary: JsonValue,
	records: PriorPage[],
	seedUrl: string,
): boolean {
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

function parseReusablePrior(
	value: JsonValue,
	config: OutputRoot,
): PriorPage | undefined {
	if (!isJsonObject(value) || value["ok"] !== true) return undefined;
	const source = jsonEnum(value["source"], discoverySources);
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
		source,
		extractor,
		redirects,
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
	] as const) {
		const item = value[key];
		if (isJsonString(item)) record[key] = item;
	}
	for (const key of ["aliases", "links"] as const) {
		const items = stringArray(value[key]);
		if (items) record[key] = items;
	}
	const kind = jsonEnum(value["kind"], pageKinds);
	if (kind) record.kind = kind;
	const byteSource = jsonEnum(value["byteSource"], byteSources);
	if (byteSource) record.byteSource = byteSource;
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

function markdownFromRendered(rendered: string): string {
	let markdown = rendered;
	if (!rendered.startsWith("---\n")) {
		return rendered.endsWith("\n") ? rendered.slice(0, -1) : rendered;
	}
	const end = rendered.indexOf("\n---\n", 4);
	if (end >= 0) markdown = rendered.slice(end + 5);
	return markdown.endsWith("\n") ? markdown.slice(0, -1) : markdown;
}
