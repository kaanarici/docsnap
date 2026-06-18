import type {
	PageOutput,
	PageRecord,
	PageSuccess,
	PathedPage,
} from "./types.ts";

export function isPageSuccess(record: PageRecord): record is PageSuccess {
	return record.ok;
}

// A success record that has been assigned an outputPath but not yet rendered.
// Path-stage consumers (link map, fetchedAt preservation) use this; only the
// materialization step promotes these to PageOutput by attaching `rendered`.
export function hasOutputPath(record: PageRecord): record is PathedPage {
	return record.ok && Boolean(record.outputPath);
}

export function isMaterialized(record: PageRecord): record is PageOutput {
	return (
		record.ok && Boolean(record.outputPath) && record.rendered !== undefined
	);
}
