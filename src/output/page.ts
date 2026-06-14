import type { PageSuccess } from "../core/types.ts";

export function renderPage(record: PageSuccess): string {
	return `${frontmatter(record)}\n${record.markdown}\n`;
}

function frontmatter(record: PageSuccess) {
	const fields = {
		title: record.title ?? "",
		url: record.url,
		finalUrl: record.finalUrl,
		status: record.status,
		source: record.source,
		fetchedAt: record.fetchedAt,
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
