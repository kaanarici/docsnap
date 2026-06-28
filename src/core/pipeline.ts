import { pruneCache } from "../cache/eviction.ts";
import { cacheSummary } from "../cache/store.ts";
import { discoverRun } from "../discover/index.ts";
import { loadRobots, type Robots } from "../discover/robots.ts";
import { candidateKey } from "../discover/seed.ts";
import { candidateWindowConfig } from "../discover/topic.ts";
import { normalizeUrl } from "../discover/url.ts";
import { extractMany } from "../extract/pool.ts";
import { fetchMany, fetchText } from "../fetch/fetcher.ts";
import { filteredNonPageResult } from "../fetch/result.ts";
import { runFiles } from "../output/files.ts";
import { rewriteLocalLinks } from "../output/links.ts";
import { renderPage } from "../output/page.ts";
import { assignOutputPaths, pathMap } from "../output/paths.ts";
import {
	conditionalForPrior,
	loadPrior,
	type PriorState,
	readPriorOutput,
	recoverPriorPage,
	resolvePriorOutputPath,
} from "../output/prior.ts";
import {
	acquireOutputLock,
	assertOutputRootSafe,
	outputDirHasContent,
	prepareOutput,
	releaseOutputLock,
	removeStalePages,
	writePages,
	writeRunFiles,
} from "../output/writer.ts";
import { buildSummary } from "../report/summary.ts";
import { dedupeRecords } from "./dedupe.ts";
import { applyInlineState } from "./inline-state.ts";
import {
	type RefreshCounters,
	refreshCounters,
	refreshSummary,
} from "./refresh.ts";
import { snapshotStats } from "./snapshot.ts";
import { countLabel } from "./text.ts";
import type {
	DiscoveredUrl,
	FetchedUrl,
	PageOutput,
	PageRecord,
	PageSuccess,
	PathedPage,
	PipelineConfig,
	PipelineResult,
	RunRecord,
} from "./types.ts";

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
	if (prior.reason === "invalid_manifest") {
		throw new Error(
			`Invalid ${runFiles.manifest} in ${config.outDir}; use a clean capture, fetch with --freshness force, or choose a different -o so raw search cannot mix stale Markdown with the new corpus.`,
		);
	}
	if (
		prior.reason === "missing_manifest" &&
		!config.clean &&
		(await outputDirHasContent(config.outDir))
	) {
		throw new Error(
			`Existing output directory has no valid ${runFiles.manifest}: ${config.outDir}. Use --clean or choose a different -o so raw search cannot mix stale Markdown with the new corpus.`,
		);
	}
	const refresh = refreshCounters();
	await prepareOutput(config);
	progress?.("docsnap: discovering");
	const discovery = await discoverRun(config);
	const discovered = discovery.urls;
	progress?.(`docsnap: fetching ${countLabel(discovered.length, "page")}`);
	const attempted = [...discovered];
	const seen = new Set(discovered.map((item) => candidateKey(item.url)));
	const records = await fetchAndExtract(
		discovered,
		config,
		prior,
		refresh,
		progress,
	);
	let dedupe = dedupeRecords(records);
	let deduped = dedupe.deduped;
	if (shouldBackfill(config, dedupe.records, discovered, deduped)) {
		progress?.("docsnap: backfilling page window");
		const extra = await backfillCandidates(config, seen);
		if (extra.length > 0) {
			attempted.push(...extra);
			const extraRecords = await fetchAndExtract(
				extra,
				config,
				prior,
				refresh,
				progress,
			);
			const backfilled = dedupeRecords([...dedupe.records, ...extraRecords]);
			deduped += backfilled.deduped;
			dedupe = backfilled;
		}
	}
	const finalRecords = dedupe.records;

	const candidates = outputCandidates(finalRecords, config);
	const pathed = preservePriorOutputPaths(
		assignOutputPaths(candidates),
		prior,
		config,
	);
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
	await removeStalePages(prior, written.outputs, config);
	refreshReport.skippedWrites = written.stats.skippedWrites;
	await pruneCache(config);
	const runRecords = recordsForRun(finalRecords, candidates, written.outputs);
	const summary = buildSummary(
		finalRecords,
		written.outputs,
		config,
		attempted.length,
		deduped,
		snapshot,
		performance.now() - started,
		firstPageMs,
		refreshReport,
		cacheSummary(config),
		discovery.seedResource,
	);
	await writeRunFiles(runRecords, summary, config);
	return { records: runRecords, summary };
}

function recordsForRun(
	records: PageRecord[],
	candidates: PageSuccess[],
	outputs: PageOutput[],
): RunRecord[] {
	const map = new Map<PageRecord, PageOutput>();
	candidates.forEach((source, index) => {
		const output = outputs[index];
		if (output) map.set(source, output);
	});
	const out: RunRecord[] = [];
	for (const record of records) {
		const output = record.ok ? map.get(record) : record;
		if (output) out.push(output);
	}
	return out;
}

async function fetchAndExtract(
	discovered: DiscoveredUrl[],
	config: PipelineConfig,
	prior: PriorState,
	refresh: RefreshCounters,
	progress?: Progress,
): Promise<PageRecord[]> {
	const robotsByOrigin = new Map<string, Robots>();
	const allowUrl = (url: string) =>
		allowedByRobots(url, config, robotsByOrigin);
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
	if (extractable.length) {
		progress?.(`docsnap: extracting ${countLabel(extractable.length, "page")}`);
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
		...(item.wasSeed ? { wasSeed: true as const } : {}),
	};
	return renderPage(current) === renderPage(recovered) ? recovered : current;
}
function shouldBackfill(
	config: PipelineConfig,
	records: PageRecord[],
	discovered: DiscoveredUrl[],
	deduped: number,
) {
	return (
		config.maxExplicit &&
		!config.pageOnly &&
		discovered.length >= config.max &&
		records.filter((record) => record.ok).length < config.max &&
		(deduped > 0 || records.some(backfillableFailure))
	);
}
function backfillableFailure(record: PageRecord) {
	if (record.ok) return false;
	if (record.failureKind === "empty") return true;
	return (
		record.failureKind === "blocked" && record.error !== "blocked by robots.txt"
	);
}
async function backfillCandidates(config: PipelineConfig, seen: Set<string>) {
	const discovered = (await discoverRun(candidateWindowConfig(config))).urls;
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
	const ok = records.filter((record): record is PageSuccess => record.ok);
	return config.maxExplicit ? ok.slice(0, config.max) : ok;
}

function preservePriorOutputPaths(
	records: PathedPage[],
	prior: PriorState,
	config: PipelineConfig,
): PathedPage[] {
	if (!prior.enabled) return records;
	const assignedOwners = new Map(
		records.map((record) => [record.outputPath, record]),
	);
	const priorPaths = new Map<PathedPage, string>();
	const priorCounts = new Map<string, number>();
	for (const record of records) {
		const outputPath = prior.find(record)?.outputPath;
		if (!outputPath || !resolvePriorOutputPath(config, outputPath)) continue;
		priorPaths.set(record, outputPath);
		priorCounts.set(outputPath, (priorCounts.get(outputPath) ?? 0) + 1);
	}
	return records.map((record) => {
		const outputPath = priorPaths.get(record);
		if (!outputPath || priorCounts.get(outputPath) !== 1) return record;
		const assignedOwner = assignedOwners.get(outputPath);
		if (assignedOwner && assignedOwner !== record) return record;
		return outputPath === record.outputPath
			? record
			: { ...record, outputPath };
	});
}

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
