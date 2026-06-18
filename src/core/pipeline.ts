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
import { hasOutputPath, isMaterialized, isPageSuccess } from "./records.ts";
import {
	type RefreshCounters,
	refreshCounters,
	refreshSummary,
} from "./refresh.ts";
import { hashContent, snapshotStats } from "./snapshot.ts";
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

	assignOutputPaths(outputCandidates(finalRecords, config));
	const links = pathMap(finalRecords);
	for (const record of finalRecords) {
		if (!record.ok) continue;
		record.markdown = rewriteLocalLinks(record, links).trim();
		record.contentHash = hashContent(record.markdown);
	}
	const outputs = await materializeOutputs(finalRecords, prior, config);
	const snapshot = snapshotStats(
		outputs.map((record) => ({
			path: record.outputPath,
			body: record.rendered,
		})),
	);
	const refreshReport = await refreshSummary(
		prior,
		finalRecords,
		attempted,
		config,
		refresh,
	);

	progress?.(config.dryRun ? "docsnap: finalizing" : "docsnap: writing output");
	const writeStats = await writePages(finalRecords, config, () => {
		firstPageMs ??= performance.now() - started;
	});
	refreshReport.skippedWrites = writeStats.skippedWrites;
	await pruneCache(config);
	const summary = buildSummary(
		finalRecords,
		config,
		attempted.length,
		dedupe.deduped,
		snapshot,
		performance.now() - started,
		firstPageMs,
		refreshReport,
		cacheSummary(config),
	);
	await writeRunFiles(finalRecords, summary, config);
	return { records: finalRecords, summary };
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
// The single point where a path-assigned success record becomes a PageOutput:
// it settles fetchedAt (preserving the prior run's timestamp when the rendered
// body is otherwise unchanged on disk) and attaches the canonical `rendered`
// string in one pass. Every downstream consumer reads record.rendered, so the
// snapshot hash, the written file, and the manifest outputHash are the same
// bytes by construction rather than by call order.
async function materializeOutputs(
	records: PageRecord[],
	prior: PriorState,
	config: PipelineConfig,
): Promise<PageOutput[]> {
	const pathed = records.filter(hasOutputPath);
	await Promise.all(
		pathed.map(async (record) => {
			record.rendered = await renderWithPreservedFetchedAt(
				record,
				prior,
				config,
			);
		}),
	);
	return pathed.filter(isMaterialized);
}

// Renders the record, preferring the prior run's fetchedAt when doing so yields a
// body byte-identical to what is already on disk. The candidate render that wins
// is the one returned, so the fetchedAt decision and the canonical serialization
// can never disagree.
async function renderWithPreservedFetchedAt(
	record: PathedPage,
	prior: PriorState,
	config: PipelineConfig,
): Promise<string> {
	const previous = prior.enabled ? prior.find(record) : undefined;
	if (
		!previous?.fetchedAt ||
		previous.outputPath !== record.outputPath ||
		previous.contentHash !== record.contentHash
	) {
		return renderPage(record);
	}
	const fetchedAt = record.fetchedAt;
	record.fetchedAt = previous.fetchedAt;
	const preserved = renderPage(record);
	if ((await readPriorOutput(config, previous.outputPath)) === preserved) {
		return preserved;
	}
	record.fetchedAt = fetchedAt;
	return renderPage(record);
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
