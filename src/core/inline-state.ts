import { extractInlineStatePage } from "../extract/inline-state-page.ts";
import type { FetchedUrl, PageRecord, RenderReason } from "./types.ts";
import { lowQualityConfidence } from "./types.ts";

type ShellReason = (
	input: FetchedUrl,
	record: PageRecord,
) => RenderReason | undefined;

export function applyInlineState(
	inputs: FetchedUrl[],
	staticRecords: PageRecord[],
	shellReason: ShellReason,
): PageRecord[] {
	const output = [...staticRecords];
	for (const [index, input] of inputs.entries()) {
		const staticRecord = output[index]!;
		if (!shellReason(input, staticRecord)) continue;
		const inlineRecord = extractInlineStatePage(input);
		if (shouldUseInlineStateRecord(staticRecord, inlineRecord)) {
			output[index] = inlineRecord;
		}
	}
	return output;
}

function shouldUseInlineStateRecord(
	staticRecord: PageRecord,
	inlineRecord: PageRecord | undefined,
): inlineRecord is PageRecord {
	if (!inlineRecord?.ok || inlineRecord.confidence < lowQualityConfidence) {
		return false;
	}
	if (!staticRecord.ok || staticRecord.confidence < lowQualityConfidence) {
		return true;
	}
	if (staticRecord.extractor === "fallback") return true;
	return (
		inlineRecord.confidence > staticRecord.confidence ||
		inlineRecord.markdown.length > staticRecord.markdown.length
	);
}
