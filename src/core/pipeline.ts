import { looksLikeAppShell } from "../discover/assets.ts";
import { discover } from "../discover/index.ts";
import { discoverPageLinks } from "../discover/nav.ts";
import { loadRobots, type Robots } from "../discover/robots.ts";
import { inScope, normalizeUrl, scopeFromSeed } from "../discover/url.ts";
import { extractMany } from "../extract/pool.ts";
import { fetchMany, fetchText } from "../fetch/fetcher.ts";
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
import { validatePublicHttpUrl } from "../security/url.ts";
import { dedupeRecords } from "./dedupe.ts";
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
		const first = await fetchAndExtract(
			discovered,
			config,
			prior,
			refresh,
			renderState,
		);
		progress?.(`docsnap: extracting ${first.records.length} pages`);
		let records = first.records;
		const renderedBackfill = await renderedLinkBackfill(
			first.rendered,
			config,
			seen,
			attempted.length,
		);
		if (renderedBackfill.length > 0) {
			attempted.push(...renderedBackfill);
			const extra = await fetchAndExtract(
				renderedBackfill,
				config,
				prior,
				refresh,
				renderState,
			);
			records = [...records, ...extra.records];
		}
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
				dedupe = dedupeRecords([...dedupe.records, ...extraRecords.records]);
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
		const writeStats = await writePages(finalRecords, config);
		refreshReport.skippedWrites = writeStats.skippedWrites;
		const summary = buildSummary(
			finalRecords,
			config,
			attempted.length,
			dedupe.deduped,
			snapshot,
			performance.now() - started,
			refreshReport,
			renderState.summary,
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
): Promise<{ records: PageRecord[]; rendered: FetchResult[] }> {
	const fetched = await fetchMany(discovered, config, (item) =>
		conditionalForPrior(prior, item),
	);
	const reused: PageRecord[] = [];
	const extractable: FetchedUrl[] = [];
	for (const item of fetched) {
		const recovered = await recoverNotModified(item, config, prior, refresh);
		if (recovered) reused.push(recovered);
		else extractable.push(rejectNonPageFinal(item));
	}
	const staticRecords = await extractMany(extractable);
	const rendered = await applyRendering(
		extractable,
		staticRecords,
		config,
		renderState,
	);
	return {
		records: [...reused, ...rendered.records],
		rendered: rendered.results,
	};
}

async function recoverNotModified(
	item: FetchedUrl,
	config: Config,
	prior: PriorState,
	refresh: RefreshCounters,
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
	item.result = await fetchText(result.url, config);
	return undefined;
}

async function applyRendering(
	inputs: FetchedUrl[],
	staticRecords: PageRecord[],
	config: Config,
	renderState: RenderState,
): Promise<{ records: PageRecord[]; results: FetchResult[] }> {
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
	if (candidates.length === 0) return { records: staticRecords, results: [] };
	const attempts = await renderCandidates(candidates, config, renderState);
	if (attempts.length === 0) return { records: staticRecords, results: [] };
	const renderedInputs = attempts
		.map((attempt) => attempt.rendered)
		.filter((input): input is FetchedUrl => Boolean(input));
	const renderedRecords = await extractMany(renderedInputs);
	const output = [...staticRecords];
	const renderedResults: FetchResult[] = [];
	let renderedIndex = 0;
	const indexByInput = new Map(
		candidates.map((item) => [item.input, item.index]),
	);
	for (const attempt of attempts) {
		const index = indexByInput.get(attempt.input);
		if (index === undefined) continue;
		const staticRecord = output[index]!;
		if (!attempt.rendered) {
			if (attempt.render) staticRecord.render = attempt.render;
			continue;
		}
		const renderedRecord = renderedRecords[renderedIndex++]!;
		renderedResults.push(attempt.rendered.result);
		if (attempt.render) renderedRecord.render = attempt.render;
		renderedRecord.timings.renderMs = attempt.page.renderMs;
		if (shouldUseRenderedRecord(staticRecord, renderedRecord)) {
			output[index] = renderedRecord;
		} else if (attempt.render) {
			staticRecord.render = attempt.render;
			staticRecord.timings.renderMs = attempt.page.renderMs;
		}
	}
	return { records: output, results: renderedResults };
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

function shouldUseRenderedRecord(
	staticRecord: PageRecord,
	renderedRecord: PageRecord,
) {
	if (!renderedRecord.ok) return false;
	return (
		!staticRecord.ok ||
		renderedRecord.confidence >= lowQualityConfidence ||
		renderedRecord.confidence > staticRecord.confidence
	);
}

async function renderedLinkBackfill(
	rendered: FetchResult[],
	config: Config,
	seen: Set<string>,
	attemptedCount: number,
): Promise<DiscoveredUrl[]> {
	if (
		config.pageOnly ||
		rendered.length === 0 ||
		attemptedCount >= config.max
	) {
		return [];
	}
	const seed = config.seedUrl;
	const scope = scopeFromSeed(seed);
	const robotsByOrigin = new Map<string, Robots>();
	const out: DiscoveredUrl[] = [];
	for (const result of rendered) {
		for (const raw of discoverPageLinks(result.body, result.finalUrl)) {
			if (attemptedCount + out.length >= config.max) return out;
			const url = normalizeUrl(raw, result.finalUrl);
			if (
				!url ||
				seen.has(candidateKey(url)) ||
				!inScope(url, seed, scope) ||
				validatePublicHttpUrl(url) ||
				!(await allowedRenderedBackfill(url, config, robotsByOrigin))
			) {
				continue;
			}
			seen.add(candidateKey(url));
			out.push({ url, source: "render" });
		}
	}
	return out;
}

async function allowedRenderedBackfill(
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
	// reuse the prior record byte-for-byte only when nothing rendered changed
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
		result: {
			url: result.url,
			finalUrl: result.finalUrl,
			redirects: result.redirects ?? [],
			status: result.status,
			contentType: result.contentType,
			body: result.body,
			fetchMs: result.fetchMs,
			...(result.etag ? { etag: result.etag } : {}),
			...(result.lastModified ? { lastModified: result.lastModified } : {}),
			fetchedAt: result.fetchedAt ?? new Date().toISOString(),
			ok: false,
			error: "redirected to a filtered non-page URL",
			failureKind: "blocked",
		},
	};
}
