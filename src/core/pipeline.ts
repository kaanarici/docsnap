import { pruneCache } from "../cache/eviction.ts";
import { resourceAllowed } from "../discover/corpus.ts";
import type { DiscoveryFrontier } from "../discover/frontier.ts";
import { startDiscovery } from "../discover/index.ts";
import type { PageResources } from "../discover/nav.ts";
import { normalizeUrl, pathAllowed } from "../discover/url.ts";
import { createExtractionPool, type ExtractionPool } from "../extract/pool.ts";
import { isLowQuality } from "../extract/quality.ts";
import {
	fetchBatches,
	fetchText,
	preferredMarkdownAccept,
} from "../fetch/fetcher.ts";
import { failed, filteredNonPageResult } from "../fetch/result.ts";
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
import { corpusLimits } from "../output/read.ts";
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
import { hashContent } from "./hash.ts";
import { candidateKey } from "./identity.ts";
import { InputError } from "./input-error.ts";
import { runBounded } from "./parallel.ts";
import { refreshSummary } from "./refresh.ts";
import type {
	FetchedUrl,
	PageOutput,
	PageRecord,
	PageSuccess,
	PathedPage,
	PipelineConfig,
	PipelineResult,
} from "./types.ts";

type PriorRecoveryUpdates = Parameters<typeof recoverPriorPage>[2];
export async function runPipeline(
	config: PipelineConfig,
	signal?: AbortSignal,
): Promise<PipelineResult> {
	signal?.throwIfAborted();
	assertOutputRootSafe(config);
	await prepareOutput(config);
	signal?.throwIfAborted();
	const lock = await acquireOutputLock(config);
	const render = createChromeSession();
	const extraction = createExtractionPool();
	const runConfig = signal ? { ...config, signal } : config;
	try {
		return await runPipelineLocked(runConfig, render, extraction, signal);
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
	signal?: AbortSignal,
): Promise<PipelineResult> {
	signal?.throwIfAborted();
	const prior = await loadPrior(config);
	if (prior.reason === "seed_mismatch") {
		throw new InputError(
			`Output directory contains a corpus for ${prior.seedUrl}, not ${config.seedUrl}.`,
			"Choose a different --out directory, or use --clean to replace this corpus.",
		);
	}
	if (prior.reason === "invalid_manifest") {
		throw new Error(
			`Invalid ${runFiles.manifest} in ${config.outDir}; rerun with --clean or choose a different -o so stale Markdown cannot mix with the new corpus.`,
		);
	}
	if (
		prior.reason === "missing_manifest" &&
		!config.clean &&
		(await outputDirHasContent(config.outDir))
	) {
		throw new Error(
			`Existing output directory has no valid ${runFiles.manifest}: ${config.outDir}. Use --clean or choose a different -o so stale Markdown cannot mix with the new corpus.`,
		);
	}
	const pageConditional = config.pageOnly
		? conditionalRequestForPrior(prior, { url: config.seedUrl })
		: undefined;
	const discovery = await startDiscovery(
		config,
		pageConditional,
		discoveryAttemptLimit(config),
	);
	signal?.throwIfAborted();
	const seen = new Set<string>();
	const discoveryOrder = new Map<string, number>();
	let pageRecords: PageRecord[] = [];
	let captured = 0;
	let stopReason: PipelineResult["summary"]["stopReason"];
	let retryAt: string | undefined;
	while (captured < config.max) {
		signal?.throwIfAborted();
		const deficit = config.max - captured;
		const discovered = await takeBatch(deficit);
		if (!discovered) break;
		const batchResults: FetchedUrl[] = [];
		for await (const fetched of fetchBatches(
			discovered,
			config,
			(item) => conditionalRequestForPrior(prior, item),
			(url) => resourceAllowed(url, config),
		)) {
			signal?.throwIfAborted();
			batchResults.push(...fetched);
			const extracted = await extractFetched(
				fetched,
				config,
				prior,
				discovery.frontier,
				render,
				extraction,
			);
			pageRecords = dedupeRecords([...pageRecords, ...extracted]);
			captured = pageRecords.filter(
				(record) =>
					record.ok && (config.maxExplicit || record.source !== "llms"),
			).length;
		}
		const allRateLimited =
			batchResults.length > 0 &&
			batchResults.every(
				(page) => !page.result.ok && page.result.status === 429,
			);
		if (allRateLimited) {
			stopReason = "rate_limited";
			retryAt = latestRetryAt(batchResults);
			break;
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
	signal?.throwIfAborted();
	const staged = await stagePages(renderedPages, config);
	try {
		signal?.throwIfAborted();
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
			refreshReport,
			discovery.seedResource,
			discovery.frontier.truncated || stopReason !== undefined,
			chromeRunSummary(render),
			stopReason,
			retryAt,
		);
		signal?.throwIfAborted();
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
function latestRetryAt(pages: FetchedUrl[]) {
	let latest: { value: string; time: number } | undefined;
	for (const page of pages) {
		if (page.result.ok || !page.result.retryAt) continue;
		const time = Date.parse(page.result.retryAt);
		if (Number.isFinite(time) && (!latest || time > latest.time)) {
			latest = { value: page.result.retryAt, time };
		}
	}
	return latest?.value;
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
			toExtract.push(rejectFilteredFinal(page, config));
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
		const original = output[index]!;
		const rendered = await renderChromePage(
			session,
			input,
			config,
			original.ok ? Math.min(remaining, 4_000) : remaining,
		);
		if (!rendered) {
			skipChrome(session, indexes.length - offset);
			break;
		}
		if (!rendered.ok) {
			session.failed++;
			session.misses++;
			if (!original.ok) {
				original.error = `client render: ${rendered.error.slice(0, 300)}`;
				if (rendered.kind === "timeout") original.failureKind = "timeout";
			}
			continue;
		}
		session.rendered++;
		const page = rejectFilteredFinal(
			{ ...input, result: rendered.result },
			config,
		);
		const [extracted] = await extraction.extractMany([page]);
		if (!extracted) {
			session.misses++;
			continue;
		}
		const [record, resources] = extracted;
		frontier.observe(page.result, resources);
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
		mergeResources(record, { links: resources.links });
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
		preferredMarkdownAccept,
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

export function rejectFilteredFinal(
	input: FetchedUrl,
	config: PipelineConfig,
): FetchedUrl {
	const { result } = input;
	if (!result.ok) return input;
	if (!input.wasSeed && !pathAllowed(result.finalUrl, config)) {
		return {
			...input,
			result: failed(
				result.url,
				result.finalUrl,
				result.status,
				"redirected to a path excluded by capture filters",
				"blocked",
				result.redirects,
			),
		};
	}
	if (normalizeUrl(result.finalUrl)) return input;
	return {
		...input,
		result: filteredNonPageResult(result, true),
	};
}
