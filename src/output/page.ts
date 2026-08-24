import type { PageSuccess } from "../core/types.ts";

export function renderPage(record: PageSuccess): string {
	return `${frontmatter(record)}\n${record.markdown}\n`;
}

function frontmatter(record: PageSuccess) {
	const fields = {
		title: record.title ?? "",
		url: record.finalUrl,
		injectionSignals: record.injectionSignals.length
			? record.injectionSignals
			: undefined,
	};
	return `---\n${Object.entries(fields)
		.filter(([, value]) => value !== undefined)
		.map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
		.join("\n")}\n---`;
}
