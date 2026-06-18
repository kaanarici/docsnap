import { byteLength, hashContent } from "../core/snapshot.ts";
import type { PageRecord, RunRecord, RunSummary } from "../core/types.ts";

// A manifest line is built from a run record: a materialized output (the written
// corpus) carries the rendered bytes and outputPath that yield the persisted
// byte/hash fields; a failure or a success dropped beyond --max manifests with
// bytes 0 and no outputHash.
export function manifestLines(records: RunRecord[]): string {
	return `${records.map((record) => JSON.stringify(toManifest(record))).join("\n")}\n`;
}

export function summaryJson(summary: RunSummary): string {
	return `${JSON.stringify(summary, null, 2)}\n`;
}

function toManifest(record: RunRecord) {
	// `rendered` is an in-memory derived field, never persisted to the manifest.
	const rendered = "rendered" in record ? record.rendered : undefined;
	const { markdown, ...entry } = withoutRendered(record);
	return {
		...entry,
		bytes: rendered ? byteLength(rendered) : 0,
		contentBytes: byteLength(markdown),
		...(rendered ? { outputHash: hashContent(rendered) } : {}),
	};
}

function withoutRendered(record: RunRecord): PageRecord {
	if ("rendered" in record) {
		const { rendered: _rendered, ...rest } = record;
		return rest;
	}
	return record;
}
