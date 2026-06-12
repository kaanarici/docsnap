import type { FetchedUrl, PageRecord } from "../core/types.ts";
import { extractInlineState } from "./inline-state.ts";
import { titleFromMarkdown } from "./markdown.ts";
import { rawInjectionSignals, recordFromExtracted } from "./page-record.ts";

export function extractInlineStatePage(
	input: FetchedUrl,
): PageRecord | undefined {
	const { result } = input;
	if (!result.ok || ("notModified" in result && result.notModified))
		return undefined;
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
			performance.now(),
			signals,
		);
	} catch {
		return undefined;
	}
}
