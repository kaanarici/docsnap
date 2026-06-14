import { pruneCache } from "../cache/eviction.ts";
import { cacheSummary } from "../cache/store.ts";
import { discover } from "../discover/index.ts";
import { loadRobots, type Robots } from "../discover/robots.ts";
import { normalizeUrl } from "../discover/url.ts";
import { looksLikeAppShell } from "../extract/app-shell.ts";
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
	assertOutputRootSafe,
	prepareOutput,
	writePages,
	writeRunFiles,
} from "../output/writer.ts";
import {
	closeRenderState,
	createRenderState,
	type RenderState,
	renderCandidates,
} from "../render/index.ts";
import { buildSummary } from "../report/summary.ts";
import { dedupeRecords } from "./dedupe.ts";
import { applyInlineState } from "./inline-state.ts";
import { hasOutputPath, isPageSuccess } from "./records.ts";
import {
	type RefreshCounters,
	refreshCounters,
	refreshSummary,
} from "./refresh.ts";
import { hashContent, snapshotStats } from "./snapshot.ts";
import type {
	Config,
	DiscoveredUrl,
	FetchedUrl,
	FetchResult,
	PageRecord,
	PageSuccess,
	PipelineResult,
	RenderReason,
} from "./types.ts";
import { lowQualityConfidence } from "./types.ts";
import { urlWithoutFragmentAndQuery } from "./url.ts";

type Progress = (message: string) => void;
const backfillExtraLimit = 8;
export async function runPipeline(
	config: Config,
	progress?: Progress,
): Promise<PipelineResult> {
	const started = performance.now();
	let firstPageMs: number | null = null;
	const renderState = createRenderState(config, progress);
	assertOutputRootSafe(config);
	try {
		const prior = await loadPrior(config);
		const refresh = refreshCounters();
		await prepareOutput(config);
		progress?.("docsnap: discovering");
		const discovered = await discover(config);
		progress?.(`docsnap: fetching ${discovered.length} pages`);
		const attempted = [...discovered];
		const seen = new Set(discovered.map((item) => candidateKey(item.url)));
		const records = await fetchAndExtract(
			discovered,
			config,
			prior,
			refresh,
			renderState,
		);
		progress?.(`docsnap: extracting ${records.length} pages`);
		let dedupe = dedupeRecords(records);
		if (shouldBackfill(config, dedupe.records, discovered)) {
			progress?.("docsnap: backfilling failed pages");
			const extra = await backfillCandidates(config, seen);
			if (extra.length > 0) {
				attempted.push(...extra);
				const extraRecords = await fetchAndExtract(
					extra,
					config,
					prior,
					refresh,
					renderState,
				);
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
		await preserveFetchedAtForUnchangedOutput(finalRecords, prior, config);
		const snapshot = snapshotStats(
			finalRecords.filter(hasOutputPath).map((record) => ({
				path: record.outputPath,
				body: renderPage(record),
			})),
		);
		const refreshReport = await refreshSummary(
			prior,
			finalRecords,
			attempted,
			config,
			refresh,
		);

		progress?.(
			config.dryRun ? "docsnap: finalizing" : "docsnap: writing output",
		);
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
			renderState.summary,
			cacheSummary(config),
		);
		await writeRunFiles(finalRecords, summary, config);
		return { records: finalRecords, summary };
	} finally {
		await closeRenderState(renderState);
	}
}
async function fetchAndExtract(
	discovered: DiscoveredUrl[],
	config: Config,
	prior: PriorState,
	refresh: RefreshCounters,
	renderState: RenderState,
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
		staticShellReason,
	);
	const rendered = await applyRendering(
		extractable,
		staticRecords,
		config,
		renderState,
	);
	return [...reused, ...rendered];
}
async function recoverNotModified(
	item: FetchedUrl,
	config: Config,
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
async function applyRendering(
	inputs: FetchedUrl[],
	staticRecords: PageRecord[],
	config: Config,
	renderState: RenderState,
): Promise<PageRecord[]> {
	const candidates = inputs
		.map((input, index) => ({
			input,
			index,
			reason: renderReason(input, staticRecords[index]!, config),
		}))
		.filter(
			(
				item,
			): item is { input: FetchedUrl; index: number; reason: RenderReason } =>
				item.reason !== undefined,
		);
	if (candidates.length === 0) return staticRecords;
	const attempts = await renderCandidates(candidates, config, renderState);
	if (attempts.length === 0) return staticRecords;
	const output = [...staticRecords];
	const indexByInput = new Map(
		candidates.map((item) => [item.input, item.index]),
	);
	for (const attempt of attempts) {
		const index = indexByInput.get(attempt.input);
		if (index === undefined) continue;
		const staticRecord = output[index]!;
		if (attempt.render) {
			staticRecord.render = attempt.render;
			staticRecord.timings.renderMs = attempt.page.renderMs;
		}
	}
	return output;
}
function renderReason(
	input: FetchedUrl,
	record: PageRecord,
	config: Config,
): RenderReason | undefined {
	const result = input.result;
	if (config.render === "never") return undefined;
	if (input.source === "asset" || !isHtmlResult(result)) return undefined;
	if (config.render === "always") return "always";
	if (
		record.ok &&
		record.extractor === "inline-state" &&
		record.confidence >= lowQualityConfidence
	) {
		return undefined;
	}
	return staticShellReason(input, record);
}
function staticShellReason(
	input: FetchedUrl,
	record: PageRecord,
): RenderReason | undefined {
	const result = input.result;
	if (input.source === "asset" || !isHtmlResult(result)) return undefined;
	const staticAppShell = looksLikeAppShell(result.body);
	const emptyAppShell =
		!record.ok &&
		record.failureKind === "empty" &&
		record.error === "app shell without static text";
	const lowConfidenceShell =
		record.ok && record.confidence < lowQualityConfidence && staticAppShell;
	if (emptyAppShell) return "empty-app-shell";
	if (lowConfidenceShell) return "low-confidence-shell";
	return staticAppShell ? "app-shell" : undefined;
}
function isHtmlResult(result: FetchResult) {
	return (
		result.ok &&
		!("notModified" in result && result.notModified) &&
		(/html|xhtml/i.test(result.contentType) ||
			/<(?:html|body|script)\b/i.test(result.body))
	);
}
async function allowedByRobots(
	url: string,
	config: Config,
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
	config: Config,
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
async function backfillCandidates(config: Config, seen: Set<string>) {
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
function outputCandidates(records: PageRecord[], config: Config) {
	const ok = records.filter(isPageSuccess);
	return config.maxExplicit ? ok.slice(0, config.max) : ok;
}
async function preserveFetchedAtForUnchangedOutput(
	records: PageRecord[],
	prior: PriorState,
	config: Config,
) {
	if (!prior.enabled) return;
	await Promise.all(
		records.filter(hasOutputPath).map(async (record) => {
			const previous = prior.find(record);
			if (
				!previous?.fetchedAt ||
				previous.outputPath !== record.outputPath ||
				previous.contentHash !== record.contentHash
			) {
				return;
			}
			const fetchedAt = record.fetchedAt;
			record.fetchedAt = previous.fetchedAt;
			if (
				(await readPriorOutput(config, previous.outputPath)) ===
				renderPage(record)
			)
				return;
			record.fetchedAt = fetchedAt;
		}),
	);
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
