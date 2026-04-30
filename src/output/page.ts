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
		extractor: record.extractor,
		confidence: record.confidence,
		contentHash: record.contentHash,
		...(record.aliases?.length ? { aliases: record.aliases } : {}),
	};
	return `---\n${Object.entries(fields)
		.map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
		.join("\n")}\n---`;
}
