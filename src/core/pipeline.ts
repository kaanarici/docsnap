import { pruneCache } from "../cache/eviction.ts";
import { cacheSummary } from "../cache/store.ts";
import { discover } from "../discover/index.ts";
import { loadRobots, type Robots } from "../discover/robots.ts";
import { normalizeUrl } from "../discover/url.ts";
import { extractMany } from "../extract/pool.ts";
import { fetchMany, fetchText } from "../fetch/fetcher.ts";
import { filteredNonPageResult } from "../fetch/result.ts";
import { rewriteLocalLinks } from "../output/links.ts";
import { renderPage } from "../output/page.ts";
import { assignOutputPaths, pathMap } from "../output/paths.ts";
import {
	conditionalForPrior,
	loadPrior,
	type PriorState,
	readPriorOutput,
	recoverPriorPage,
} from "../output/prior.ts";
import {
	acquireOutputLock,
	assertOutputRootSafe,
	prepareOutput,
	releaseOutputLock,
	writePages,
	writeRunFiles,
} from "../output/writer.ts";
import { buildSummary } from "../report/summary.ts";
import { dedupeRecords } from "./dedupe.ts";
import { applyInlineState } from "./inline-state.ts";
import { isPageSuccess } from "./records.ts";
import {
	type RefreshCounters,
	refreshCounters,
	refreshSummary,
} from "./refresh.ts";
import { snapshotStats } from "./snapshot.ts";
import type {
	DiscoveredUrl,
	FetchedUrl,
	PageOutput,
	PageRecord,
	PageSuccess,
	PathedPage,
	PipelineConfig,
	PipelineResult,
} from "./types.ts";
import { urlWithoutFragmentAndQuery } from "./url.ts";

type Progress = (message: string) => void;
const backfillExtraLimit = 8;
export async function runPipeline(
	config: PipelineConfig,
	progress?: Progress,
): Promise<PipelineResult> {
	assertOutputRootSafe(config);
	const lock = await acquireOutputLock(config);
	try {
		return await runLocked(config, progress);
	} finally {
		await releaseOutputLock(lock);
	}
}
async function runLocked(
	config: PipelineConfig,
	progress?: Progress,
): Promise<PipelineResult> {
	const started = performance.now();
	let firstPageMs: number | null = null;
	const prior = await loadPrior(config);
	const refresh = refreshCounters();
	await prepareOutput(config);
	progress?.("docsnap: discovering");
	const discovered = await discover(config);
	progress?.(`docsnap: fetching ${discovered.length} pages`);
	const attempted = [...discovered];
	const seen = new Set(discovered.map((item) => candidateKey(item.url)));
	const records = await fetchAndExtract(discovered, config, prior, refresh);
	progress?.(`docsnap: extracting ${records.length} pages`);
	let dedupe = dedupeRecords(records);
	if (shouldBackfill(config, dedupe.records, discovered)) {
		progress?.("docsnap: backfilling failed pages");
		const extra = await backfillCandidates(config, seen);
		if (extra.length > 0) {
			attempted.push(...extra);
			const extraRecords = await fetchAndExtract(extra, config, prior, refresh);
			dedupe = dedupeRecords([...dedupe.records, ...extraRecords]);
		}
	}
	const finalRecords = dedupe.records;

	const candidates = outputCandidates(finalRecords, config);
	const pathed = assignOutputPaths(candidates);
	const links = pathMap(pathed);
	const rewritten = pathed.map((record) => rewriteLocalLinks(record, links));
	const outputs = await materializeOutputs(rewritten, prior, config);
	const snapshot = snapshotStats(
		outputs.map((record) => ({
			path: record.outputPath,
			body: record.rendered,
		})),
	);
	const refreshReport = await refreshSummary(
		prior,
		finalRecords,
		outputs,
		attempted,
		config,
		refresh,
	);

	progress?.(config.dryRun ? "docsnap: finalizing" : "docsnap: writing output");
	const written = await writePages(outputs, config, () => {
		firstPageMs ??= performance.now() - started;
	});
	refreshReport.skippedWrites = written.stats.skippedWrites;
	await pruneCache(config);
	// Merge the settled outputs (rewritten markdown, settled writeMs, rendered)
	// back onto the attempted-record list by source identity so the manifest and
	// the returned records carry the materialized state without any in-place
	// mutation of the original records.
	const settled = settledBySource(candidates, written.outputs);
	const manifestRecords = finalRecords.map(
		(record) => settled.get(record) ?? record,
	);
	const summary = buildSummary(
		finalRecords,
		written.outputs,
		config,
		attempted.length,
		dedupe.deduped,
		snapshot,
		performance.now() - started,
		firstPageMs,
		refreshReport,
		cacheSummary(config),
	);
	await writeRunFiles(manifestRecords, written.outputs, summary, config);
	return { records: manifestRecords, summary };
}

function settledBySource(
	candidates: PageSuccess[],
	outputs: PageOutput[],
): Map<PageRecord, PageOutput> {
	const map = new Map<PageRecord, PageOutput>();
	candidates.forEach((source, index) => {
		const output = outputs[index];
		if (output) map.set(source, output);
	});
	return map;
}
async function fetchAndExtract(
	discovered: DiscoveredUrl[],
	config: PipelineConfig,
	prior: PriorState,
	refresh: RefreshCounters,
): Promise<PageRecord[]> {
	const robotsByOrigin = new Map<string, Robots>();
	const allowUrl = config.ignoreRobots
		? undefined
		: (url: string) => allowedByRobots(url, config, robotsByOrigin);
	const fetched = await fetchMany(
		discovered,
		config,
		(item) => conditionalForPrior(prior, item),
		allowUrl,
	);
	const reused: PageRecord[] = [];
	const extractable: FetchedUrl[] = [];
	for (const item of fetched) {
		const recovered = await recoverNotModified(
			item,
			config,
			prior,
			refresh,
			allowUrl,
		);
		if (recovered) reused.push(recovered);
		else extractable.push(rejectNonPageFinal(item));
	}
	const staticRecords = applyInlineState(
		extractable,
		await extractMany(extractable),
	);
	return [...reused, ...staticRecords];
}
async function recoverNotModified(
	item: FetchedUrl,
	config: PipelineConfig,
	prior: PriorState,
	refresh: RefreshCounters,
	allowUrl: ((url: string) => Promise<boolean>) | undefined,
): Promise<PageRecord | undefined> {
	const result = item.result;
	if (!result.ok || !result.notModified) return undefined;
	refresh.notModified++;
	const previous = prior.find({ url: result.url, finalUrl: result.finalUrl });
	const recovered = previous
		? await recoverPriorPage(config, previous, {
				fetchMs: result.fetchMs,
				...(result.etag ? { etag: result.etag } : {}),
				...(result.lastModified ? { lastModified: result.lastModified } : {}),
				...(result.fetchedAt ? { fetchedAt: result.fetchedAt } : {}),
			})
		: undefined;
	if (recovered) {
		refresh.reused++;
		return mergeRecoveredDiscovery(recovered, item);
	}
	refresh.fallbackRefetches++;
	item.result = await fetchText(
		result.url,
		config,
		undefined,
		undefined,
		allowUrl,
	);
	return undefined;
}
async function allowedByRobots(
	url: string,
	config: PipelineConfig,
	robotsByOrigin: Map<string, Robots>,
) {
	if (config.ignoreRobots) return true;
	const origin = new URL(url).origin;
	const robots =
		robotsByOrigin.get(origin) ?? (await loadRobots(origin, config));
	robotsByOrigin.set(origin, robots);
	return robots.allowed(url);
}
function mergeRecoveredDiscovery(
	recovered: PageSuccess,
	item: FetchedUrl,
): PageSuccess {
	const current: PageSuccess = {
		...recovered,
		...(item.metadata ?? {}),
		source: item.source,
	};
	return renderPage(current) === renderPage(recovered) ? recovered : current;
}
function shouldBackfill(
	config: PipelineConfig,
	records: PageRecord[],
	discovered: DiscoveredUrl[],
) {
	return (
		config.maxExplicit &&
		!config.pageOnly &&
		discovered.length >= config.max &&
		records.filter(isPageSuccess).length < config.max &&
		records.some((record) => !record.ok && record.failureKind === "empty")
	);
}
async function backfillCandidates(config: PipelineConfig, seen: Set<string>) {
	const discovered = await discover({
		...config,
		max: config.max + backfillExtraLimit,
	});
	const out: DiscoveredUrl[] = [];
	for (const item of discovered) {
		const key = candidateKey(item.url);
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(item);
		if (out.length >= backfillExtraLimit) break;
	}
	return out;
}
function outputCandidates(records: PageRecord[], config: PipelineConfig) {
	const ok = records.filter(isPageSuccess);
	return config.maxExplicit ? ok.slice(0, config.max) : ok;
}
// The single stage transition where a PathedPage becomes a PageOutput: it settles
// fetchedAt (preserving the prior run's timestamp when the rendered body is
// otherwise unchanged on disk) and attaches the canonical `rendered` string in one
// constructed value. Every downstream consumer reads record.rendered, so the
// snapshot hash, the written file, and the manifest outputHash are the same bytes
// by construction rather than by call order.
async function materializeOutputs(
	records: PathedPage[],
	prior: PriorState,
	config: PipelineConfig,
): Promise<PageOutput[]> {
	return Promise.all(
		records.map(async (record) => {
			const { fetchedAt, rendered } = await settleRender(record, prior, config);
			return { ...record, fetchedAt, rendered };
		}),
	);
}

// Pure decision: prefer the prior run's fetchedAt when rendering with it yields a
// body byte-identical to what is already on disk. Both candidate bodies are
// computed without mutating the record, so no concurrent reader can observe an
// intermediate fetchedAt across the disk read, and the winning fetchedAt always
// matches the winning serialization.
async function settleRender(
	record: PathedPage,
	prior: PriorState,
	config: PipelineConfig,
): Promise<{ fetchedAt: string; rendered: string }> {
	const previous = prior.enabled ? prior.find(record) : undefined;
	const current = { fetchedAt: record.fetchedAt, rendered: renderPage(record) };
	if (
		!previous?.fetchedAt ||
		previous.outputPath !== record.outputPath ||
		previous.contentHash !== record.contentHash
	) {
		return current;
	}
	const preserved = {
		fetchedAt: previous.fetchedAt,
		rendered: renderPage(record, previous.fetchedAt),
	};
	return (await readPriorOutput(config, previous.outputPath)) ===
		preserved.rendered
		? preserved
		: current;
}
function candidateKey(raw: string) {
	const url = new URL(urlWithoutFragmentAndQuery(raw));
	if (url.pathname !== "/") url.pathname = url.pathname.replace(/\/+$/, "");
	url.pathname = url.pathname.replace(/\.(?:html?|mdx?|txt)$/i, "");
	return url.href;
}
function rejectNonPageFinal(input: FetchedUrl): FetchedUrl {
	const { result } = input;
	if (!result.ok || normalizeUrl(result.finalUrl)) return input;
	return {
		...input,
		result: filteredNonPageResult(result.url, result.finalUrl, {
			redirects: result.redirects ?? [],
			status: result.status,
			contentType: result.contentType,
			body: result.body,
			fetchMs: result.fetchMs,
			...(result.etag ? { etag: result.etag } : {}),
			...(result.lastModified ? { lastModified: result.lastModified } : {}),
			...(result.fetchedAt ? { fetchedAt: result.fetchedAt } : {}),
			defaultFetchedAt: true,
		}),
	};
}
