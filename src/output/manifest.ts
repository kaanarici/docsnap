import { byteLength, hashContent } from "../core/snapshot.ts";
import type { PageRecord, RunSummary } from "../core/types.ts";
import { renderPage } from "./page.ts";

export function manifestLines(records: PageRecord[]): string {
	return `${records.map((record) => JSON.stringify(toManifest(record))).join("\n")}\n`;
}

export function summaryJson(summary: RunSummary): string {
	return `${JSON.stringify(summary, null, 2)}\n`;
}

function toManifest(record: PageRecord) {
	const { markdown, ...entry } = record;
	const rendered = record.ok && record.outputPath ? renderPage(record) : "";
	return {
		...entry,
		bytes: rendered ? byteLength(rendered) : 0,
		contentBytes: byteLength(markdown),
		...(rendered ? { outputHash: hashContent(rendered) } : {}),
	};
}
