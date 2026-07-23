import { pruneCache } from "../cache/eviction.ts";
import { cacheSummary } from "../cache/store.ts";
import { assetSignature, discoverAssetPages } from "../discover/assets.ts";
import { discoverRun } from "../discover/index.ts";
import { loadRobots } from "../discover/robots.ts";
import { candidateKey } from "../discover/seed.ts";
import { inScope, normalizeUrl, scopeFromSeed } from "../discover/url.ts";
import { looksLikeAppShell } from "../extract/app-shell.ts";
import {
	fetchMany,
	fetchText,
	preferredMarkdownAccept,
} from "../fetch/fetcher.ts";
import { filteredNonPageResult } from "../fetch/result.ts";
import { runFiles } from "../output/files.ts";
import { rewriteLocalLinks } from "../output/links.ts";
import { renderPage } from "../output/page.ts";
import { assignOutputPaths, pathMap } from "../output/paths.ts";
import {
	conditionalRequestForPrior,
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
import { awaitWithSignal } from "./parallel.ts";
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
import { lowQualityConfidence } from "./types.ts";

type Progress = (message: string) => void;
type ExtractedBatch = {
	records: PageRecord[];
	discovered: DiscoveredUrl[];
	truncated: boolean;
};
type RecoveryContext = { signal?: AbortSignal; deadline?: number };
const backfillExtraLimit = 8;
const assetRecoveryGraphLimit = 4;
const extractModule = import("../extract/pool.ts");
export async function runPipeline(
	config: PipelineConfig,
	progress?: Progress,
): Promise<PipelineResult> {
	assertOutputRootSafe(config);
	const lock = await acquireOutputLock(config);
	try {
		return await runPipelineLocked(config, progress);
	} finally {
		await releaseOutputLock(lock);
	}
}
async function runPipelineLocked(
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
	const recoveryContext: RecoveryContext = {};
	await prepareOutput(config);
	progress?.("docsnap: discovering");
	const pageConditional = config.pageOnly
		? conditionalRequestForPrior(prior, { url: config.seedUrl })
		: undefined;
	const discovery = await discoverRun(config, pageConditional);
	const discovered = discovery.urls;
	progress?.(`docsnap: fetching ${countLabel(discovered.length, "page")}`);
	const attempted = [...discovered];
	const seen = new Set(discovered.map((item) => candidateKey(item.url)));
	const initial = await fetchAndExtract(
		discovered,
		config,
		prior,
		refresh,
		seen,
		config.max,
		recoveryContext,
		progress,
	);
	attempted.push(...initial.discovered);
	let assetRecoveryTruncated = initial.truncated;
	let dedupeResult = dedupeRecords(initial.records);
	let deduped = dedupeResult.deduped;
	if (shouldBackfill(config, dedupeResult.records, discovered, deduped)) {
		progress?.("docsnap: backfilling page window");
		const candidates = await backfillCandidates(config, seen);
		let offset = 0;
		while (offset < candidates.length) {
			const deficit = config.max - successCount(dedupeResult.records);
			if (deficit <= 0) break;
			const extra = candidates.slice(offset, offset + deficit);
			offset += extra.length;
			attempted.push(...extra);
			const extraBatch = await fetchAndExtract(
				extra,
				config,
				prior,
				refresh,
				seen,
				deficit,
				recoveryContext,
				progress,
			);
			attempted.push(...extraBatch.discovered);
			assetRecoveryTruncated ||= extraBatch.truncated;
			const next = dedupeRecords([
				...dedupeResult.records,
				...extraBatch.records,
			]);
			deduped += next.deduped;
			dedupeResult = next;
		}
	}
	const pageRecords = dedupeResult.records;

	const successfulPages = outputCandidates(pageRecords, config);
	const pathedPages = preservePriorOutputPaths(
		assignOutputPaths(successfulPages),
		prior,
		config,
	);
	const localPaths = pathMap(pathedPages);
	const linkedPages = pathedPages.map((record) =>
		rewriteLocalLinks(record, localPaths),
	);
	const renderedPages = await materializeOutputs(linkedPages, prior, config);
	if (prior.enabled && prior.records.length > 0 && renderedPages.length === 0) {
		throw new Error(
			"Refresh captured no pages; existing corpus left unchanged.",
		);
	}
	const snapshot = snapshotStats(
		renderedPages.map((record) => ({
			path: record.outputPath,
			body: record.rendered,
		})),
	);
	const refreshReport = await refreshSummary(
		prior,
		renderedPages,
		config,
		refresh,
	);

	progress?.(config.dryRun ? "docsnap: finalizing" : "docsnap: writing output");
	const written = await writePages(renderedPages, config, () => {
		firstPageMs ??= performance.now() - started;
	});
	await removeStalePages(prior, written.outputs, config);
	refreshReport.skippedWrites = written.stats.skippedWrites;
	await pruneCache(config);
	const runRecords = recordsForRun(
		pageRecords,
		successfulPages,
		written.outputs,
	);
	const summary = buildSummary(
		pageRecords,
		written.outputs,
		config,
		attempted,
		deduped,
		snapshot,
		performance.now() - started,
		firstPageMs,
		refreshReport,
		cacheSummary(config),
		discovery.seedResource,
		assetRecoveryTruncated,
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
	const runRecords: RunRecord[] = [];
	for (const record of records) {
		const output = record.ok ? map.get(record) : record;
		if (output) runRecords.push(output);
	}
	return runRecords;
}

async function fetchAndExtract(
	discovered: DiscoveredUrl[],
	config: PipelineConfig,
	prior: PriorState,
	refresh: RefreshCounters,
	seen: Set<string>,
	remainingSlots: number,
	recoveryContext: RecoveryContext,
	progress?: Progress,
): Promise<ExtractedBatch> {
	const allowUrl = (url: string) => allowedByRobots(url, config);
	const fetched = await fetchMany(
		discovered,
		config,
		(item) => conditionalRequestForPrior(prior, item),
		allowUrl,
	);
	const reusedPages: PageRecord[] = [];
	const toExtract: FetchedUrl[] = [];
	for (const page of fetched) {
		const recovered = await recoverNotModified(
			page,
			config,
			prior,
			refresh,
			allowUrl,
		);
		if (recovered) reusedPages.push(recovered);
		else toExtract.push(rejectNonPageFinal(page));
	}
	if (toExtract.length) {
		progress?.(`docsnap: extracting ${countLabel(toExtract.length, "page")}`);
	}
	const extractedRecords = applyInlineState(
		toExtract,
		await (await extractModule).extractMany(toExtract),
	);
	const recovery = await recoverAppShells(
		toExtract,
		extractedRecords,
		config,
		allowUrl,
		seen,
		Math.max(
			0,
			remainingSlots -
				countTowardMax(reusedPages, config) -
				countTowardMax(extractedRecords, config),
		),
		recoveryContext,
		progress,
	);
	return {
		records: [...reusedPages, ...extractedRecords, ...recovery.records],
		discovered: recovery.discovered,
		truncated: recovery.truncated,
	};
}

async function recoverAppShells(
	inputs: FetchedUrl[],
	records: PageRecord[],
	config: PipelineConfig,
	allowUrl: (url: string) => Promise<boolean>,
	seen: Set<string>,
	availableSlots: number,
	recoveryContext: RecoveryContext,
	progress?: Progress,
): Promise<ExtractedBatch> {
	const groups = new Map<
		string,
		{ input: FetchedUrl; targetIndexByUrl: Map<string, number> }
	>();
	let truncated = false;
	for (const [index, input] of inputs.entries()) {
		const record = records[index];
		const result = input.result;
		if (
			!record ||
			record.ok ||
			record.failureKind !== "empty" ||
			!result.ok ||
			result.notModified ||
			!looksLikeAppShell(result.body)
		) {
			continue;
		}
		if (
			!config.pageOnly &&
			availableSlots === 0 &&
			countsTowardMax(record, config)
		) {
			truncated = true;
			continue;
		}
		const signature = assetSignature(result.finalUrl, result.body);
		if (!signature) continue;
		const group = groups.get(signature) ?? {
			input,
			targetIndexByUrl: new Map<string, number>(),
		};
		if (input.wasSeed) group.input = input;
		for (const url of [record.url, record.finalUrl]) {
			const key = candidateKey(url);
			if (input.wasSeed || !group.targetIndexByUrl.has(key)) {
				group.targetIndexByUrl.set(key, index);
			}
		}
		groups.set(signature, group);
	}
	if (groups.size === 0) return { records: [], discovered: [], truncated };
	const recoveryGroups = [...groups.values()].sort(
		(left, right) => Number(!left.input.wasSeed) - Number(!right.input.wasSeed),
	);

	progress?.("docsnap: recovering app shells");
	const recoveryScope = scopeFromSeed(config.seedUrl);
	recoveryContext.signal ??= AbortSignal.timeout(config.timeoutMs);
	recoveryContext.deadline ??= performance.now() + config.timeoutMs;
	const { signal, deadline } = recoveryContext as Required<RecoveryContext>;
	let remainingCandidates = config.pageOnly ? 0 : availableSlots;
	const recoveredInputs: Array<{
		index?: number;
		input: FetchedUrl;
		page?: DiscoveredUrl;
	}> = [];
	const deadlineFailure = () => ({
		records: [],
		discovered: [],
		truncated: true,
	});
	truncated ||= recoveryGroups.length > assetRecoveryGraphLimit;
	for (const group of recoveryGroups.slice(0, assetRecoveryGraphLimit)) {
		const result = group.input.result;
		if (!result.ok || result.notModified) continue;
		const targetIndexes = new Set(group.targetIndexByUrl.values());
		const targetUrls = [...group.targetIndexByUrl.keys()].map(
			(url) => new URL(url),
		);
		const freeTargets = [...targetIndexes].filter((index) => {
			const record = records[index];
			return record && !countsTowardMax(record, config);
		}).length;
		const started = performance.now();
		const assetDeadline = deadline - Math.min(250, config.timeoutMs / 10);
		const assetSignal = AbortSignal.timeout(
			Math.max(1, Math.floor(assetDeadline - performance.now())),
		);
		const assetPages = await discoverAssetPages(
			result.finalUrl,
			result.body,
			config,
			{
				limit: config.pageOnly
					? targetIndexes.size
					: remainingCandidates + freeTargets,
				signal: assetSignal,
				deadline: assetDeadline,
				required: (url) => group.targetIndexByUrl.get(candidateKey(url)),
				requiredUnder: (url) => {
					const prefix = new URL(url);
					const path = prefix.pathname.replace(/\/+$/, "");
					return targetUrls.some(
						(target) =>
							target.origin === prefix.origin &&
							(target.pathname === path ||
								target.pathname.startsWith(`${path}/`)),
					);
				},
				requiredCount: targetIndexes.size,
				accept: (url) => {
					const key = candidateKey(url);
					return (
						group.targetIndexByUrl.has(key) ||
						(remainingCandidates > 0 &&
							!seen.has(key) &&
							inScope(url, result.finalUrl, recoveryScope))
					);
				},
				allowResource: allowUrl,
			},
		);
		if (assetPages.truncated) {
			truncated = true;
		}
		const recoveryMs = performance.now() - started;
		for (const page of assetPages.pages) {
			const synthetic = page.fetched;
			if (!synthetic?.ok || synthetic.notModified) continue;
			if (
				!(await awaitWithSignal(allowUrl(page.url), signal).catch(() => false))
			)
				continue;
			const key = candidateKey(page.url);
			const index = group.targetIndexByUrl.get(key);
			if (index !== undefined) {
				const original = inputs[index];
				if (original?.result.ok && !original.result.notModified) {
					recoveredInputs.push({
						index,
						input: recoveredInput(original, synthetic.body, recoveryMs),
					});
				}
			}
			if (index !== undefined || remainingCandidates === 0 || seen.has(key)) {
				continue;
			}
			seen.add(key);
			remainingCandidates--;
			recoveredInputs.push({
				input: { source: page.source, result: synthetic },
				page,
			});
		}
	}
	if (signal.aborted || performance.now() >= deadline) return deadlineFailure();
	if (recoveredInputs.length === 0) {
		return { records: [], discovered: [], truncated };
	}

	recoveredInputs.sort(
		(left, right) =>
			(left.index ?? inputs.length) - (right.index ?? inputs.length),
	);
	const recoveredRecords = await awaitWithSignal(
		(await extractModule).extractMany(
			recoveredInputs.map((item) => item.input),
		),
		signal,
	).catch(() => undefined);
	if (!recoveredRecords) return deadlineFailure();
	let remainingSuccesses = availableSlots;
	const extraRecords: PageRecord[] = [];
	const discovered: DiscoveredUrl[] = [];
	for (const [offset, recovered] of recoveredRecords.entries()) {
		const recovery = recoveredInputs[offset]!;
		if (recovery.index === undefined) {
			const limited = recovered.ok && countsTowardMax(recovered, config);
			if (!recovery.page || (limited && remainingSuccesses === 0)) continue;
			extraRecords.push(recovered);
			discovered.push(recovery.page);
			if (limited) remainingSuccesses--;
			continue;
		}
		if (
			!recovered.ok ||
			recovered.confidence < lowQualityConfidence ||
			(countsTowardMax(recovered, config) && remainingSuccesses === 0)
		) {
			continue;
		}
		const original = records[recovery.index]!;
		recovered.injectionSignals = [
			...new Set([...original.injectionSignals, ...recovered.injectionSignals]),
		];
		records[recovery.index] = recovered;
		if (countsTowardMax(recovered, config)) remainingSuccesses--;
	}
	return { records: extraRecords, discovered, truncated };
}

function recoveredInput(
	original: FetchedUrl,
	markdown: string,
	recoveryMs: number,
): FetchedUrl {
	const result = original.result;
	if (!result.ok || result.notModified) return original;
	return {
		...original,
		result: {
			url: result.url,
			finalUrl: result.finalUrl,
			status: result.status,
			contentType: "text/markdown",
			body: markdown,
			ok: true,
			fetchMs: result.fetchMs + recoveryMs,
			redirects: result.redirects ?? [],
			...(result.fetchedAt ? { fetchedAt: result.fetchedAt } : {}),
		},
	};
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
	const previous = prior.find({
		url: result.url,
		finalUrl: result.finalUrl,
	});
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
		config.pageOnly && item.wasSeed ? preferredMarkdownAccept : undefined,
		undefined,
		allowUrl,
	);
	return undefined;
}
async function allowedByRobots(url: string, config: PipelineConfig) {
	const origin = new URL(url).origin;
	return (await loadRobots(origin, config)).allowed(url);
}
function mergeRecoveredDiscovery(
	recovered: PageSuccess,
	item: FetchedUrl,
): PageSuccess {
	const updated: PageSuccess = {
		...recovered,
		...(item.metadata ?? {}),
		source: item.source,
		...(item.wasSeed ? { wasSeed: true as const } : {}),
	};
	return renderPage(updated) === renderPage(recovered) ? recovered : updated;
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
		successCount(records) < config.max &&
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
	const discovered = (
		await discoverRun({ ...config, max: config.max + backfillExtraLimit })
	).urls;
	const candidates: DiscoveredUrl[] = [];
	for (const candidate of discovered) {
		const key = candidateKey(candidate.url);
		if (seen.has(key)) continue;
		seen.add(key);
		candidates.push(candidate);
		if (candidates.length >= backfillExtraLimit) break;
	}
	return candidates;
}
function successCount(records: PageRecord[]) {
	return records.filter((record) => record.ok).length;
}
function countTowardMax(records: PageRecord[], config: PipelineConfig) {
	return records.filter(
		(record) => record.ok && countsTowardMax(record, config),
	).length;
}
function countsTowardMax(
	record: Pick<PageRecord, "source">,
	config: PipelineConfig,
) {
	return config.maxExplicit || record.source !== "llms";
}
function outputCandidates(records: PageRecord[], config: PipelineConfig) {
	const successful = records.filter(
		(record): record is PageSuccess => record.ok,
	);
	return config.maxExplicit ? successful.slice(0, config.max) : successful;
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
			const { fetchedAt, rendered } = await stableRender(record, prior, config);
			return { ...record, fetchedAt, rendered };
		}),
	);
}

async function stableRender(
	record: PathedPage,
	prior: PriorState,
	config: PipelineConfig,
): Promise<{ fetchedAt: string; rendered: string }> {
	const previous = prior.enabled ? prior.find(record) : undefined;
	const fresh = { fetchedAt: record.fetchedAt, rendered: renderPage(record) };
	if (
		!previous?.fetchedAt ||
		previous.outputPath !== record.outputPath ||
		previous.contentHash !== record.contentHash
	) {
		return fresh;
	}
	const stable = {
		fetchedAt: previous.fetchedAt,
		rendered: renderPage(record, previous.fetchedAt),
	};
	return (await readPriorOutput(config, previous.outputPath)) ===
		stable.rendered
		? stable
		: fresh;
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
