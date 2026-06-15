import { looksLikeAppShell } from "../extract/app-shell.ts";
import { extractInlineStatePage } from "../extract/inline-state-page.ts";
import type { FetchedUrl, FetchResult, PageRecord } from "./types.ts";
import { lowQualityConfidence } from "./types.ts";

type InlineStateReason =
	| "app-shell"
	| "empty-app-shell"
	| "low-confidence-shell";

export function applyInlineState(
	inputs: FetchedUrl[],
	staticRecords: PageRecord[],
): PageRecord[] {
	const output = [...staticRecords];
	for (const [index, input] of inputs.entries()) {
		const staticRecord = output[index]!;
		const reason = inlineStateReason(input, staticRecord);
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
	reason: InlineStateReason | undefined,
) {
	// a failed static record (including empty-app-shell) already returned true
	// above; these reasons only gate the ok-but-thin cases
	if (!staticRecord.ok) return true;
	return (
		reason === "low-confidence-shell" ||
		(reason === "app-shell" &&
			(staticRecord.extractor === "fallback" ||
				staticRecord.extractor === "structured"))
	);
}

function shouldUseInlineStateRecord(
	staticRecord: PageRecord,
	inlineRecord: PageRecord | undefined,
	reason: InlineStateReason | undefined,
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

function inlineStateReason(
	input: FetchedUrl,
	record: PageRecord,
): InlineStateReason | undefined {
	const result = input.result;
	if (input.source === "asset" || !isHtmlResult(result)) return undefined;
	const staticAppShell = looksLikeAppShell(result.body);
	const emptyAppShell =
		!record.ok &&
		record.failureKind === "empty" &&
		record.error === "app shell without static text";
	const lowConfidenceShell =
		record.ok && record.confidence < lowQualityConfidence && staticAppShell;
	if (emptyAppShell) return "empty-app-shell";
	if (lowConfidenceShell) return "low-confidence-shell";
	return staticAppShell ? "app-shell" : undefined;
}

function isHtmlResult(result: FetchResult) {
	return (
		result.ok &&
		!("notModified" in result && result.notModified) &&
		(/html|xhtml/i.test(result.contentType) ||
			/<(?:html|body|script)\b/i.test(result.body))
	);
}
