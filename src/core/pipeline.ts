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
import { hasOutputPath } from "./records.ts";
import { hashContent, snapshotStats } from "./snapshot.ts";
import type { Config, FetchedUrl, PipelineResult } from "./types.ts";

type Progress = (message: string) => void;

export async function runPipeline(
	config: Config,
	progress?: Progress,
): Promise<PipelineResult> {
	const started = performance.now();
	await prepareOutput(config);
	progress?.("docsnap: discovering");
	const discovered = await discover(config);
	progress?.(`docsnap: fetching ${discovered.length} pages`);
	const fetched = (await fetchMany(discovered, config)).map(rejectNonPageFinal);
	progress?.(`docsnap: extracting ${fetched.length} pages`);
	const dedupe = dedupeRecords(await extractMany(fetched));
	const records = dedupe.records;

	assignOutputPaths(records);
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
		discovered.length,
		dedupe.deduped,
		snapshot,
		performance.now() - started,
	);
	await writeRunFiles(records, summary, config);

	return { records, summary };
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
