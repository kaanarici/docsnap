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
		const reason = shellReason(input, staticRecord);
		if (!shouldAttemptInlineState(staticRecord, reason)) continue;
		const inlineRecord = extractInlineStatePage(input);
		if (shouldUseInlineStateRecord(staticRecord, inlineRecord, reason)) {
			output[index] = inlineRecord;
		}
	}
	return output;
}

function shouldAttemptInlineState(
	staticRecord: PageRecord,
	reason: RenderReason | undefined,
) {
	if (!staticRecord.ok) return true;
	return (
		reason === "empty-app-shell" ||
		reason === "low-confidence-shell" ||
		(reason === "app-shell" &&
			(staticRecord.extractor === "fallback" ||
				staticRecord.extractor === "structured"))
	);
}

function shouldUseInlineStateRecord(
	staticRecord: PageRecord,
	inlineRecord: PageRecord | undefined,
	reason: RenderReason | undefined,
): inlineRecord is PageRecord {
	if (!inlineRecord?.ok || inlineRecord.confidence < lowQualityConfidence) {
		return false;
	}
	if (!staticRecord.ok) return true;
	return (
		reason === "low-confidence-shell" ||
		(reason === "app-shell" &&
			(staticRecord.extractor === "fallback" ||
				staticRecord.extractor === "structured"))
	);
}
