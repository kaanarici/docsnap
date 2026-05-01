import { discover } from "../discover/index.ts";
import { normalizeUrl } from "../discover/url.ts";
import { extractMany } from "../extract/pool.ts";
import { fetchMany } from "../fetch/fetcher.ts";
import { rewriteLocalLinks } from "../output/links.ts";
import { renderPage } from "../output/page.ts";
import { assignOutputPaths, pathMap } from "../output/paths.ts";
import { prepareOutput, writePages, writeRunFiles } from "../output/writer.ts";
import { buildSummary } from "../report/summary.ts";
import { dedupeRecords } from "./dedupe.ts";
import { hasOutputPath, isPageSuccess } from "./records.ts";
import { hashContent, snapshotStats } from "./snapshot.ts";
import type {
	Config,
	DiscoveredUrl,
	FetchedUrl,
	PageRecord,
	PipelineResult,
} from "./types.ts";
import { urlWithoutFragmentAndQuery } from "./url.ts";

type Progress = (message: string) => void;
const backfillExtraLimit = 8;

export async function runPipeline(
	config: Config,
	progress?: Progress,
): Promise<PipelineResult> {
	const started = performance.now();
	await prepareOutput(config);
	progress?.("docsnap: discovering");
	const discovered = await discover(config);
	progress?.(`docsnap: fetching ${discovered.length} pages`);
	const attempted = [...discovered];
	const seen = new Set(discovered.map((item) => candidateKey(item.url)));
	const fetched = await fetchDiscovered(discovered, config);
	progress?.(`docsnap: extracting ${fetched.length} pages`);
	let dedupe = dedupeRecords(await extractMany(fetched));
	if (shouldBackfill(config, dedupe.records, discovered)) {
		progress?.("docsnap: backfilling failed pages");
		const extra = await backfillCandidates(config, seen);
		if (extra.length > 0) {
			attempted.push(...extra);
			const extraRecords = await extractMany(
				await fetchDiscovered(extra, config),
			);
			dedupe = dedupeRecords([...dedupe.records, ...extraRecords]);
		}
	}
	const records = dedupe.records;

	assignOutputPaths(outputCandidates(records, config));
	const links = pathMap(records);
	for (const record of records) {
		if (!record.ok) continue;
		record.markdown = rewriteLocalLinks(record, links).trim();
		record.contentHash = hashContent(record.markdown);
	}
	const snapshot = snapshotStats(
		records.filter(hasOutputPath).map((record) => ({
			path: record.outputPath,
			body: renderPage(record),
		})),
	);

	progress?.(config.dryRun ? "docsnap: finalizing" : "docsnap: writing output");
	await writePages(records, config);
	const summary = buildSummary(
		records,
		config,
		attempted.length,
		dedupe.deduped,
		snapshot,
		performance.now() - started,
	);
	await writeRunFiles(records, summary, config);

	return { records, summary };
}

async function fetchDiscovered(
	discovered: DiscoveredUrl[],
	config: Config,
): Promise<FetchedUrl[]> {
	return (await fetchMany(discovered, config)).map(rejectNonPageFinal);
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
			status: result.status,
			contentType: result.contentType,
			body: result.body,
			fetchMs: result.fetchMs,
			ok: false,
			error: "redirected to a filtered non-page URL",
			failureKind: "blocked",
		},
	};
}
