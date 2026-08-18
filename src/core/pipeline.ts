import { pruneCache } from "../cache/eviction.ts";
import { cacheSummary } from "../cache/store.ts";
import { corpusLimits } from "../corpus/access.ts";
import { resourceAllowed } from "../discover/corpus.ts";
import type { DiscoveryFrontier } from "../discover/frontier.ts";
import { startDiscovery } from "../discover/index.ts";
import type { PageResources } from "../discover/nav.ts";
import { normalizeUrl } from "../discover/url.ts";
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
	commitStagedOutput,
	discardStagedOutput,
	outputDirHasContent,
	prepareOutput,
	releaseOutputLock,
	stagePages,
	stageStalePages,
} from "../output/writer.ts";
import type { ChromiumRenderer } from "../render/chromium.ts";
import { buildSummary } from "../report/summary.ts";
import {
	discoveryAttemptLimit,
	maxGeneratedCapturePages,
	maxGeneratedMediaUrls,
} from "./config.ts";
import { dedupeRecords } from "./dedupe.ts";
import { candidateKey } from "./identity.ts";
import { runBounded } from "./parallel.ts";
import {
	type RefreshCounters,
	refreshCounters,
	refreshSummary,
} from "./refresh.ts";
import {
	hashContent,
	snapshotLeaf,
	snapshotStatsFromLeaves,
} from "./snapshot.ts";
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
import { lowQualityConfidence } from "./types.ts";

type Progress = (message: string) => void;
type RenderContext = NonNullable<PipelineResult["summary"]["render"]> & {
	browser?: ChromiumRenderer;
	misses: number;
};
type PriorRecoveryUpdates = Parameters<typeof recoverPriorPage>[2];
const maxConsecutiveRenderMisses = 3;
const extractModule = import("../extract/pool.ts");
export async function runPipeline(
	config: PipelineConfig,
	progress?: Progress,
): Promise<PipelineResult> {
	assertOutputRootSafe(config);
	const lock = await acquireOutputLock(config);
	const render: RenderContext = {
		renderer: "chrome-cdp",
		attempted: 0,
		rendered: 0,
		recovered: 0,
		failed: 0,
		launchMs: 0,
		renderMs: 0,
		blockedRequests: 0,
		fulfilledRequests: 0,
		relayedBytes: 0,
		skipped: 0,
		truncated: false,
		misses: 0,
	};
	try {
		return await runPipelineLocked(config, render, progress);
	} finally {
		try {
			await render.browser?.close();
		} finally {
			await releaseOutputLock(lock);
		}
	}
}
async function runPipelineLocked(
	config: PipelineConfig,
	render: RenderContext,
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
	const pageConditional = config.pageOnly
		? conditionalRequestForPrior(prior, { url: config.seedUrl })
		: undefined;
	const discovery = await startDiscovery(
		config,
		pageConditional,
		discoveryAttemptLimit(config),
	);
	const attempted: DiscoveredUrl[] = [];
	const seen = new Set<string>();
	let pageRecords: PageRecord[] = [];
	let deduped = 0;
	let captured = 0;
	progress?.("docsnap: fetching and extracting pages");
	while (captured < config.max) {
		const deficit = config.max - captured;
		const pulled = await discovery.frontier.take(
			Math.min(config.perOrigin, deficit),
		);
		if (pulled.length === 0) break;
		const batch = pulled.filter((item) => {
			const key = candidateKey(item.url);
			if (seen.has(key)) return false;
			seen.add(key);
			return true;
		});
		if (batch.length === 0) continue;
		attempted.push(...batch);
		const extracted = await fetchAndExtract(
			batch,
			config,
			prior,
			refresh,
			discovery.frontier,
			render,
			() => {
				firstPageMs ??= performance.now() - started;
			},
			progress,
		);
		const next = dedupeRecords([...pageRecords, ...extracted]);
		deduped += next.deduped;
		pageRecords = next.records;
		captured = pageRecords.filter(
			(record) => record.ok && (config.maxExplicit || record.source !== "llms"),
		).length;
	}
	await render.browser?.close();
	delete render.browser;

	const successfulPages = pageRecords
		.filter((record): record is PageSuccess => record.ok)
		.slice(0, config.maxExplicit ? config.max : maxGeneratedCapturePages);
	let outputPaths = preservePriorOutputPaths(
		assignOutputPaths(successfulPages),
		prior,
		config,
	);
	let outputSources = successfulPages;
	let renderedPages: PageOutput[];
	for (;;) {
		const localPaths = pathMap(outputPaths);
		const linkedPages = outputPaths.map((record) =>
			rewriteLocalLinks(record, localPaths),
		);
		const materialized = await materializeOutputs(linkedPages, prior, config);
		const limited = partitionPageOutputs(
			pageRecords,
			outputSources,
			materialized,
		);
		pageRecords = limited.records;
		renderedPages = limited.outputs;
		if (limited.rejectedIndexes.length === 0) break;
		const rejected = new Set(limited.rejectedIndexes);
		outputPaths = outputPaths.filter((_, index) => !rejected.has(index));
		outputSources = limited.candidates;
	}
	const refreshReport = await refreshSummary(
		prior,
		renderedPages,
		config,
		refresh,
	);
	const intentionalDownsize =
		config.maxExplicit &&
		config.max < prior.records.length &&
		renderedPages.length === config.max;
	const confirmedRemovedPaths = new Set(
		pageRecords.flatMap((record) => {
			if (record.ok || record.failureKind !== "not_found") return [];
			const previous = prior.find(record);
			return previous ? [previous.outputPath] : [];
		}),
	);
	const unconfirmedRemoval = refreshReport.changedPages.some(
		(change) =>
			change.change === "removed" &&
			(!change.previousOutputPath ||
				!confirmedRemovedPaths.has(change.previousOutputPath)),
	);
	const incompleteTraversal =
		discovery.frontier.truncated ||
		pageRecords.some(
			(record) => !record.ok && record.failureKind !== "not_found",
		);
	if (
		prior.enabled &&
		unconfirmedRemoval &&
		incompleteTraversal &&
		!intentionalDownsize
	) {
		throw new Error("Refresh was incomplete; existing corpus left unchanged.");
	}
	if (prior.enabled && prior.records.length > 0 && renderedPages.length === 0) {
		throw new Error(
			"Refresh captured no pages; existing corpus left unchanged.",
		);
	}
	const snapshot = snapshotStatsFromLeaves(
		renderedPages.map((record) =>
			snapshotLeaf(record.outputPath, record.rendered, record.outputHash),
		),
	);
	progress?.(config.dryRun ? "docsnap: finalizing" : "docsnap: writing output");
	const staged = await stagePages(renderedPages, config);
	try {
		await stageStalePages(staged, prior, config);
		refreshReport.pageWrites = config.dryRun
			? 0
			: staged.outputs.length - staged.skippedWrites;
		refreshReport.skippedWrites = staged.skippedWrites;
		await pruneCache(config);
		const rendered = new Map(
			outputSources.map(
				(source, index) => [source, staged.outputs[index]!] as const,
			),
		);
		const runRecords = pageRecords.flatMap((record) => {
			const output = record.ok ? rendered.get(record) : record;
			return output ? [output] : [];
		});
		const { browser: _browser, misses: _misses, ...renderStats } = render;
		const summary = buildSummary(
			pageRecords,
			staged.outputs,
			config,
			attempted,
			deduped,
			snapshot,
			performance.now() - started,
			firstPageMs,
			refreshReport,
			cacheSummary(config),
			discovery.seedResource,
			discovery.frontier.truncated,
			render.attempted === 0
				? undefined
				: {
						...renderStats,
						launchMs: Number(renderStats.launchMs.toFixed(1)),
						renderMs: Number(renderStats.renderMs.toFixed(1)),
					},
		);
		await commitStagedOutput(staged, runRecords, summary, config);
		return { records: runRecords, summary };
	} finally {
		await discardStagedOutput(staged);
	}
}

export function partitionPageOutputs(
	records: PageRecord[],
	candidates: PageSuccess[],
	outputs: PageOutput[],
) {
	if (candidates.length !== outputs.length) {
		throw new Error(
			"Page output materialization did not preserve record order",
		);
	}
	const failures = new Map<PageSuccess, PageRecord>();
	const acceptedCandidates: PageSuccess[] = [];
	const acceptedOutputs: PageOutput[] = [];
	const rejectedIndexes: number[] = [];
	for (const [index, candidate] of candidates.entries()) {
		const output = outputs[index]!;
		const bytes = Buffer.byteLength(output.rendered);
		if (bytes <= corpusLimits.pageBytes) {
			acceptedCandidates.push(candidate);
			acceptedOutputs.push(output);
			continue;
		}
		rejectedIndexes.push(index);
		failures.set(candidate, {
			...candidate,
			ok: false,
			markdown: "",
			links: [],
			contentHash: "",
			extractor: "none",
			confidence: 0,
			qualityReasons: [],
			error: `Rendered page exceeds corpus page limit (${Math.ceil(corpusLimits.pageBytes / 1024 / 1024)}MB)`,
			failureKind: "too_large",
		});
	}
	return {
		records: records.map((record) =>
			record.ok ? (failures.get(record) ?? record) : record,
		),
		candidates: acceptedCandidates,
		outputs: acceptedOutputs,
		rejectedIndexes,
	};
}

async function fetchAndExtract(
	discovered: DiscoveredUrl[],
	config: PipelineConfig,
	prior: PriorState,
	refresh: RefreshCounters,
	frontier: DiscoveryFrontier,
	render: RenderContext,
	onContent: () => void,
	progress?: Progress,
): Promise<PageRecord[]> {
	const allowUrl = (url: string) => resourceAllowed(url, config);
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
		if (recovered) {
			frontier.observeLinks(recovered.finalUrl, recovered.links);
			reusedPages.push(recovered);
		} else {
			toExtract.push(rejectNonPageFinal(page));
		}
	}
	const extracted = await (await extractModule).extractMany(toExtract);
	const extractedRecords = extracted.map(([record, resources], index) => {
		frontier.observe(toExtract[index]!.result, resources);
		mergeResources(record, resources);
		return record;
	});
	const shells = extracted.map(([, , shell]) => shell);
	const hadContent =
		reusedPages.some((record) => record.ok) ||
		extractedRecords.some((record) => record.ok);
	if (hadContent) onContent();
	const renderedRecords = await renderAppShells(
		toExtract,
		extractedRecords,
		shells,
		config,
		frontier,
		render,
		progress,
	);
	if (!hadContent && renderedRecords.some((record) => record.ok)) onContent();
	return [...reusedPages, ...renderedRecords];
}

async function renderAppShells(
	inputs: FetchedUrl[],
	records: PageRecord[],
	shells: boolean[],
	config: PipelineConfig,
	frontier: DiscoveryFrontier,
	context: RenderContext,
	progress?: Progress,
): Promise<PageRecord[]> {
	const indexes = inputs.flatMap((input, index) => {
		const record = records[index];
		const result = input.result;
		const shell =
			record &&
			shells[index] &&
			(record.ok
				? record.confidence < lowQualityConfidence
				: record.failureKind === "empty");
		return result.ok && !result.notModified && shell ? [index] : [];
	});
	if (indexes.length === 0) return records;
	if (context.stopReason || context.unavailable) {
		context.skipped += indexes.length;
		return records;
	}
	const budget = Math.min(
		120_000,
		Math.max(config.timeoutMs, config.max * 1_500),
	);
	if (!context.browser) {
		const { openChromiumRenderer } = await import("../render/chromium.ts");
		const opened = await openChromiumRenderer(config);
		if (!opened.ok) {
			context.attempted++;
			context.failed++;
			context.launchMs = opened.launchMs;
			context.unavailable = opened.error;
			context.skipped += indexes.length;
			return records;
		}
		context.browser = opened.renderer;
	}

	progress?.("docsnap: rendering app shells");
	const output = [...records];
	for (const [offset, index] of indexes.entries()) {
		if (context.misses >= maxConsecutiveRenderMisses) {
			context.skipped += indexes.length - offset;
			context.truncated = true;
			context.stopReason = "no_recovery";
			break;
		}
		const remaining = budget - context.renderMs;
		if (remaining <= 0) {
			context.skipped += indexes.length - offset;
			context.truncated = true;
			context.stopReason = "budget";
			break;
		}
		const input = inputs[index]!;
		context.attempted++;
		const result = await context.browser.renderPage(input.result, {
			explicitSeed: input.wasSeed === true,
			signal: AbortSignal.timeout(
				Math.max(1, Math.min(config.timeoutMs, Math.ceil(remaining))),
			),
		});
		context.launchMs ||= result.metrics.launchMs;
		context.renderMs += result.metrics.renderMs;
		context.blockedRequests += result.metrics.blockedRequests;
		context.fulfilledRequests += result.metrics.fulfilledRequests;
		context.relayedBytes += result.metrics.relayedBytes;
		context.truncated ||= result.metrics.truncated;
		if (!result.ok) {
			context.failed++;
			context.misses++;
			const record = output[index];
			if (record && !record.ok) {
				record.error = `client render: ${result.error.slice(0, 300)}`;
				if (result.kind === "timeout") record.failureKind = "timeout";
			}
			continue;
		}
		context.rendered++;
		const page = { ...input, result: result.result };
		const [extracted] = await (await extractModule).extractMany([page]);
		if (!extracted) {
			context.misses++;
			continue;
		}
		const [record, resources] = extracted;
		frontier.observe(page.result, resources);
		const { metrics } = result;
		const original = output[index]!;
		const renderMetrics: NonNullable<PageRecord["render"]> = {
			renderer: "chrome-cdp",
			renderMs: Number(metrics.renderMs.toFixed(1)),
			blockedRequests: metrics.blockedRequests,
			fulfilledRequests: metrics.fulfilledRequests,
			relayedBytes: metrics.relayedBytes,
		};
		if (metrics.truncated) renderMetrics.truncated = true;
		record.render = renderMetrics;
		record.injectionSignals = [
			...new Set([...original.injectionSignals, ...record.injectionSignals]),
		];
		if (!record.ok) {
			context.misses++;
			if (!page.result.ok) output[index] = record;
			continue;
		}
		if (
			original.ok &&
			record.confidence < lowQualityConfidence &&
			record.confidence <= original.confidence
		) {
			context.misses++;
			continue;
		}
		context.recovered++;
		context.misses = 0;
		mergeResources(record, {
			links: resources.links,
			media: [...resources.media, ...metrics.mediaUrls],
		});
		delete record.etag;
		delete record.lastModified;
		output[index] = record;
	}
	return output;
}

function mergeResources(record: PageRecord, page?: PageResources) {
	if (!page) return;
	if (record.ok && page.links.length) {
		record.links = [...new Set([...record.links, ...page.links])].slice(
			0,
			maxGeneratedCapturePages,
		);
	}
	if (page.media.length) {
		record.media = [...new Set([...(record.media ?? []), ...page.media])].slice(
			0,
			maxGeneratedMediaUrls,
		);
	}
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
	const updates: PriorRecoveryUpdates = { fetchMs: result.fetchMs };
	if (result.etag) updates.etag = result.etag;
	if (result.lastModified) updates.lastModified = result.lastModified;
	if (result.fetchedAt) updates.fetchedAt = result.fetchedAt;
	const recovered =
		previous && (config.pageOnly || Array.isArray(previous.links))
			? await recoverPriorPage(config, previous, updates)
			: undefined;
	if (recovered) {
		refresh.reused++;
		const updated: PageSuccess = { ...recovered, source: item.source };
		if (item.metadata?.publishedAt)
			updated.publishedAt = item.metadata.publishedAt;
		if (item.metadata?.updatedAt) updated.updatedAt = item.metadata.updatedAt;
		if (item.wasSeed) updated.wasSeed = true;
		return updated;
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
	return runBounded(
		records,
		{
			concurrency: config.concurrency,
			perOrigin: config.concurrency,
			key: () => "output",
		},
		async (record) => {
			const previous = prior.enabled ? prior.find(record) : undefined;
			let fetchedAt = record.fetchedAt;
			let rendered: string;
			if (
				previous?.fetchedAt &&
				previous.outputPath === record.outputPath &&
				previous.contentHash === record.contentHash
			) {
				rendered = renderPage(record, previous.fetchedAt);
				if ((await readPriorOutput(config, previous.outputPath)) === rendered) {
					fetchedAt = previous.fetchedAt;
				} else {
					rendered = renderPage(record);
				}
			} else {
				rendered = renderPage(record);
			}
			return {
				...record,
				fetchedAt,
				rendered,
				outputHash: hashContent(rendered),
			};
		},
	);
}

function rejectNonPageFinal(input: FetchedUrl): FetchedUrl {
	const { result } = input;
	if (!result.ok || normalizeUrl(result.finalUrl)) return input;
	return {
		...input,
		result: filteredNonPageResult(result, true),
	};
}
