import type { PageOutput, PageRecord, PageSuccess } from "./types.ts";

export function isPageSuccess(record: PageRecord): record is PageSuccess {
	return record.ok;
}

export function hasOutputPath(record: PageRecord): record is PageOutput {
	return record.ok && Boolean(record.outputPath);
}
