import type {
	PageOutput,
	PageRecord,
	PageSuccess,
	RunRecord,
} from "./types.ts";

export function isPageSuccess(record: PageRecord): record is PageSuccess {
	return record.ok;
}

// Discriminates a finished run record: a written-to-disk page (PageOutput) from a
// failure or a success dropped beyond --max. Unlike the removed stage predicates,
// this gates a genuine union of distinct constructed values, not in-place field
// promotion on one shared object.
export function isWritten(record: RunRecord): record is PageOutput {
	return record.ok && "rendered" in record;
}
