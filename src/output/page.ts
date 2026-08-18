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
		kind: record.kind,
		byteSource: record.byteSource,
		confidence: record.confidence,
		contentHash: record.contentHash,
		requestedSeed: record.wasSeed ? true : undefined,
		qualityReasons: record.qualityReasons.length
			? record.qualityReasons
			: undefined,
		injectionSignals: record.injectionSignals.length
			? record.injectionSignals
			: undefined,
		publishedAt: record.publishedAt || undefined,
		updatedAt: record.updatedAt || undefined,
		aliases: record.aliases?.length ? record.aliases : undefined,
		redirects: record.redirects.length ? record.redirects : undefined,
	};
	return `---\n${Object.entries(fields)
		.filter(([, value]) => value !== undefined)
		.map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
		.join("\n")}\n---`;
}
