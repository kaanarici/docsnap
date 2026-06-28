import { looksLikeAppShell } from "../extract/app-shell.ts";
import { extractInlineState } from "../extract/inline-state.ts";
import {
	rawInjectionSignals,
	recordFromExtracted,
} from "../extract/page-record.ts";
import { titleFromMarkdown } from "../extract/title.ts";
import type {
	FetchedUrl,
	FetchResult,
	PageRecord,
	PageSuccess,
} from "./types.ts";
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

function extractInlineStatePage(input: FetchedUrl): PageRecord | undefined {
	const { result } = input;
	if (!result.ok || ("notModified" in result && result.notModified))
		return undefined;
	const started = performance.now();
	const signals = rawInjectionSignals(result);
	try {
		const inline = extractInlineState(result.body, result.finalUrl);
		if (!inline) return undefined;
		const title = titleFromMarkdown(
			inline.markdown,
			new URL(result.finalUrl).pathname,
		);
		return recordFromExtracted(
			input,
			{
				markdown: inline.markdown,
				extractor: "inline-state",
				inlineStateSource: inline.source,
				title,
			},
			started,
			signals,
		);
	} catch {
		return undefined;
	}
}

function shouldAttemptInlineState(
	staticRecord: PageRecord,
	reason: InlineStateReason | undefined,
) {
	// a failed static record (including empty-app-shell) already returned true
	// above; these reasons only gate the ok-but-thin cases
	if (!staticRecord.ok) return true;
	return reasonGatesThinRecord(staticRecord, reason);
}

function reasonGatesThinRecord(
	staticRecord: PageSuccess,
	reason: InlineStateReason | undefined,
) {
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
	return reasonGatesThinRecord(staticRecord, reason);
}

function inlineStateReason(
	input: FetchedUrl,
	record: PageRecord,
): InlineStateReason | undefined {
	const result = input.result;
	if (input.source === "asset" || !isHtmlResult(result)) return undefined;
	// skip the app-shell DOM parse on the hot path: a confident html record can
	// never trigger inline-state recovery (no reason below gates it), so probing
	// its full body would be wasted work on every normal page in a crawl
	if (
		record.ok &&
		record.confidence >= lowQualityConfidence &&
		record.extractor === "html"
	) {
		return undefined;
	}
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
