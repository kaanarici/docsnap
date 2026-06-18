import { byteLength, hashContent } from "../core/snapshot.ts";
import type { PageRecord, RunSummary } from "../core/types.ts";

export function manifestLines(records: PageRecord[]): string {
	return `${records.map((record) => JSON.stringify(toManifest(record))).join("\n")}\n`;
}

export function summaryJson(summary: RunSummary): string {
	return `${JSON.stringify(summary, null, 2)}\n`;
}

function toManifest(record: PageRecord) {
	// `rendered` is an in-memory derived field, never persisted to the manifest.
	const { markdown, rendered, ...entry } = withRendered(record);
	return {
		...entry,
		bytes: rendered ? byteLength(rendered) : 0,
		contentBytes: byteLength(markdown),
		...(rendered ? { outputHash: hashContent(rendered) } : {}),
	};
}

function withRendered(record: PageRecord): PageRecord & { rendered?: string } {
	return record;
}
