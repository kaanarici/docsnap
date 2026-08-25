import { pruneCache } from "../cache/eviction.ts";
import { corpusLimits } from "../corpus/access.ts";
import { resourceAllowed } from "../discover/corpus.ts";
import type { DiscoveryFrontier } from "../discover/frontier.ts";
import { startDiscovery } from "../discover/index.ts";
import type { PageResources } from "../discover/nav.ts";
import { normalizeUrl } from "../discover/url.ts";
import { createExtractionPool, type ExtractionPool } from "../extract/pool.ts";
import { isLowQuality } from "../extract/quality.ts";
import {
	fetchBatches,
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
import {
	type ChromeSession,
	chromeBudgetMs,
	chromeRunSummary,
	chromeStopped,
	closeChromeSession,
	createChromeSession,
	maxConsecutiveRenderMisses,
	needsChrome,
	renderChromePage,
	skipChrome,
} from "../render/session.ts";
import { buildSummary } from "../report/summary.ts";
import { discoveryAttemptLimit, maxGeneratedCapturePages } from "./config.ts";
import { dedupeRecords } from "./dedupe.ts";
import { candidateKey } from "./identity.ts";
import { runBounded } from "./parallel.ts";
import { refreshSummary } from "./refresh.ts";
import {
	hashContent,
	snapshotLeaf,
	snapshotStatsFromLeaves,
} from "./snapshot.ts";
import type {
	FetchedUrl,
	PageOutput,
	PageRecord,
	PageSuccess,
	PathedPage,
	PipelineConfig,
	PipelineResult,
} from "./types.ts";

type Progress = (message: string) => void;
type PriorRecoveryUpdates = Parameters<typeof recoverPriorPage>[2];
export async function runPipeline(
	config: PipelineConfig,
	progress?: Progress,
): Promise<PipelineResult> {
	assertOutputRootSafe(config);
	const lock = await acquireOutputLock(config);
	const render = createChromeSession();
	const extraction = createExtractionPool();
	try {
		return await runPipelineLocked(config, render, extraction, progress);
	} finally {
		try {
			await extraction.close();
		} finally {
			try {
				await closeChromeSession(render);
			} finally {
				await releaseOutputLock(lock);
			}
		}
	}
}
async function runPipelineLocked(
	config: PipelineConfig,
	render: ChromeSession,
	extraction: ExtractionPool,
	progress?: Progress,
): Promise<PipelineResult> {
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
	const seen = new Set<string>();
	const discoveryOrder = new Map<string, number>();
	let pageRecords: PageRecord[] = [];
	let captured = 0;
	let stopReason: PipelineResult["summary"]["stopReason"];
	progress?.("docsnap: fetching and extracting pages");
	capture: while (captured < config.max) {
		const deficit = config.max - captured;
		const discovered = await takeBatch(deficit);
		if (!discovered) break;
		let rateLimited = 0;
		for await (const fetched of fetchBatches(
			discovered,
			config,
			(item) => conditionalRequestForPrior(prior, item),
			(url) => resourceAllowed(url, config),
		)) {
			rateLimited = fetched.every(
				(page) => !page.result.ok && page.result.status === 429,
			)
				? rateLimited + fetched.length
				: 0;
			const extracted = await extractFetched(
				fetched,
				config,
				prior,
				discovery.frontier,
				render,
				extraction,
				progress,
			);
			pageRecords = dedupeRecords([...pageRecords, ...extracted]);
			captured = pageRecords.filter(
				(record) =>
					record.ok && (config.maxExplicit || record.source !== "llms"),
			).length;
			if (rateLimited >= config.perOrigin) {
				stopReason = "rate_limited";
				break capture;
			}
		}
	}
	pageRecords.sort(
		(a, b) =>
			(discoveryOrder.get(candidateKey(a.url)) ?? Number.MAX_SAFE_INTEGER) -
			(discoveryOrder.get(candidateKey(b.url)) ?? Number.MAX_SAFE_INTEGER),
	);
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
	const refreshReport = await refreshSummary(prior, renderedPages, config);
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
		const summary = buildSummary(
			pageRecords,
			staged.outputs,
			config,
			snapshot,
			refreshReport,
			discovery.seedResource,
			discovery.frontier.truncated || stopReason !== undefined,
			chromeRunSummary(render),
			stopReason,
		);
		await commitStagedOutput(staged, runRecords, summary, config);
		return { records: runRecords, summary };
	} finally {
		await discardStagedOutput(staged);
	}

	async function takeBatch(limit: number) {
		for (;;) {
			const pulled = await discovery.frontier.take(limit);
			if (pulled.length === 0) return undefined;
			const discovered = pulled.filter((item) => {
				const key = candidateKey(item.url);
				if (seen.has(key)) return false;
				seen.add(key);
				return true;
			});
			if (discovered.length === 0) continue;
			for (const item of discovered) {
				discoveryOrder.set(candidateKey(item.url), discoveryOrder.size);
			}
			return discovered;
		}
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

async function extractFetched(
	fetched: FetchedUrl[],
	config: PipelineConfig,
	prior: PriorState,
	frontier: DiscoveryFrontier,
	render: ChromeSession,
	extraction: ExtractionPool,
	progress?: Progress,
): Promise<PageRecord[]> {
	const allowUrl = (url: string) => resourceAllowed(url, config);
	const reusedPages: PageRecord[] = [];
	const toExtract: FetchedUrl[] = [];
	for (const page of fetched) {
		const recovered = await recoverNotModified(page, config, prior, allowUrl);
		if (recovered) {
			frontier.observeLinks(recovered.finalUrl, recovered.links);
			reusedPages.push(recovered);
		} else {
			toExtract.push(rejectNonPageFinal(page));
		}
	}
	const extracted = await extraction.extractMany(toExtract);
	const extractedRecords = extracted.map(([record, resources], index) => {
		frontier.observe(toExtract[index]!.result, resources);
		mergeResources(record, resources);
		return record;
	});
	const shells = extracted.map(([, , shell]) => shell);
	const renderedRecords = await renderAppShells(
		toExtract,
		extractedRecords,
		shells,
		config,
		frontier,
		render,
		extraction,
		progress,
	);
	return [...reusedPages, ...renderedRecords];
}

async function renderAppShells(
	inputs: FetchedUrl[],
	records: PageRecord[],
	shells: boolean[],
	config: PipelineConfig,
	frontier: DiscoveryFrontier,
	session: ChromeSession,
	extraction: ExtractionPool,
	progress?: Progress,
): Promise<PageRecord[]> {
	const indexes = inputs.flatMap((input, index) => {
		const record = records[index];
		return record &&
			input.result.ok &&
			!input.result.notModified &&
			needsChrome(record, shells[index] === true)
			? [index]
			: [];
	});
	if (indexes.length === 0) return records;
	if (chromeStopped(session)) {
		skipChrome(session, indexes.length);
		return records;
	}
	const budget = chromeBudgetMs(config);
	progress?.("docsnap: rendering app shells");
	const output = [...records];
	for (const [offset, index] of indexes.entries()) {
		if (session.misses >= maxConsecutiveRenderMisses) {
			skipChrome(session, indexes.length - offset, "no_recovery");
			break;
		}
		const remaining = budget - session.renderMs;
		if (remaining <= 0) {
			skipChrome(session, indexes.length - offset, "budget");
			break;
		}
		const input = inputs[index]!;
		const originalRecord = output[index]!;
		const result = await renderChromePage(
			session,
			input,
			config,
			originalRecord.ok ? Math.min(remaining, 4_000) : remaining,
		);
		if (!result) {
			skipChrome(session, indexes.length - offset);
			break;
		}
		if (!result.ok) {
			session.failed++;
			session.misses++;
			if (!originalRecord.ok) {
				originalRecord.error = `client render: ${result.error.slice(0, 300)}`;
				if (result.kind === "timeout") originalRecord.failureKind = "timeout";
			}
			continue;
		}
		session.rendered++;
		const page = { ...input, result: result.result };
		const [extracted] = await extraction.extractMany([page]);
		if (!extracted) {
			session.misses++;
			continue;
		}
		const [record, resources] = extracted;
		frontier.observe(page.result, resources);
		const original = originalRecord;
		record.injectionSignals = [
			...new Set([...original.injectionSignals, ...record.injectionSignals]),
		];
		if (!record.ok) {
			session.misses++;
			if (!page.result.ok) output[index] = record;
			continue;
		}
		frontier.observeLinks(record.finalUrl, record.links);
		if (
			original.ok &&
			isLowQuality(record.qualityReasons) &&
			(!isLowQuality(original.qualityReasons) ||
				record.qualityReasons.length >= original.qualityReasons.length)
		) {
			session.misses++;
			continue;
		}
		session.recovered++;
		session.misses = 0;
		record.byteSource = "chrome";
		mergeResources(record, {
			links: resources.links,
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
}
async function recoverNotModified(
	item: FetchedUrl,
	config: PipelineConfig,
	prior: PriorState,
	allowUrl: ((url: string) => Promise<boolean>) | undefined,
): Promise<PageRecord | undefined> {
	const result = item.result;
	if (!result.ok || !result.notModified) return undefined;
	const previous = prior.find({
		url: result.url,
		finalUrl: result.finalUrl,
	});
	const updates: PriorRecoveryUpdates = {};
	if (result.etag) updates.etag = result.etag;
	if (result.lastModified) updates.lastModified = result.lastModified;
	if (result.fetchedAt) updates.fetchedAt = result.fetchedAt;
	const recovered =
		previous && (config.pageOnly || Array.isArray(previous.links))
			? await recoverPriorPage(config, previous, updates)
			: undefined;
	if (recovered) {
		const updated: PageSuccess = { ...recovered, source: item.source };
		if (item.wasSeed) updated.wasSeed = true;
		return updated;
	}
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
			const rendered = renderPage(record);
			if (
				previous?.fetchedAt &&
				previous.outputPath === record.outputPath &&
				previous.contentHash === record.contentHash &&
				(await readPriorOutput(config, previous.outputPath)) === rendered
			) {
				fetchedAt = previous.fetchedAt;
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
