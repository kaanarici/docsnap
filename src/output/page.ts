import type { PageSuccess } from "../core/types.ts";

// fetchedAt may be overridden so callers can render a candidate body for a prior
// run's timestamp without mutating the record (see fetchedAt preservation).
export function renderPage(record: PageSuccess, fetchedAt?: string): string {
	return `${frontmatter(record, fetchedAt ?? record.fetchedAt)}\n${record.markdown}\n`;
}

function frontmatter(record: PageSuccess, fetchedAt: string) {
	const fields = {
		title: record.title ?? "",
		url: record.url,
		finalUrl: record.finalUrl,
		status: record.status,
		source: record.source,
		fetchedAt,
		extractor: record.extractor,
		confidence: record.confidence,
		...(record.qualityReasons.length
			? { qualityReasons: record.qualityReasons }
			: {}),
		contentHash: record.contentHash,
		...(record.injectionSignals.length
			? { injectionSignals: record.injectionSignals }
			: {}),
		...(record.publishedAt ? { publishedAt: record.publishedAt } : {}),
		...(record.updatedAt ? { updatedAt: record.updatedAt } : {}),
		...(record.aliases?.length ? { aliases: record.aliases } : {}),
		...(record.redirects.length ? { redirects: record.redirects } : {}),
	};
	return `---\n${Object.entries(fields)
		.map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
		.join("\n")}\n---`;
}
