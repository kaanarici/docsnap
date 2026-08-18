import type { FetchedUrl } from "../core/types.ts";
import { failedRecord, recordFromExtracted } from "./page-record.ts";
import { titleFromMarkdown } from "./title.ts";

export async function extractDocument(input: FetchedUrl, started: number) {
	const { result } = input;
	const bytes = result.document;
	if (!bytes) throw new Error("missing document payload");
	const path = new URL(result.finalUrl).pathname;
	try {
		const anydoc = await import("@firecrawl/anydoc");
		const format =
			anydoc.formatFromBytes(bytes) ??
			anydoc.formatFromPath(path) ??
			(/^text\/csv(?:;|$)/i.test(result.contentType)
				? anydoc.Format.csv
				: null);
		const markdown = await anydoc.toMarkdownBytes(bytes, format);
		const record = recordFromExtracted(
			input,
			{
				markdown,
				extractor: "markdown",
				title: titleFromMarkdown(markdown, path.replace(/\.[^./]+$/, "")),
			},
			started,
			[],
			false,
		);
		return record;
	} catch (error) {
		const failure = error instanceof Error ? error : new Error(String(error));
		return failedRecord(
			result,
			input.source,
			input.metadata,
			documentError(failure, path),
			"code" in failure && failure.code === "resourceLimit"
				? "too_large"
				: "extract",
			[],
			input.wasSeed,
		);
	}
}

function documentError(error: Error, path: string) {
	const code = "code" in error ? error.code : undefined;
	if (code === "unsupported") {
		return /\.pdf$/i.test(path)
			? "PDF requires OCR or contains no extractable text"
			: "unsupported document format";
	}
	if (code === "encrypted") return "encrypted document";
	if (code === "malformed") return "malformed document";
	if (code === "resourceLimit") return "document exceeds parser safety limits";
	if (code === "missingPart") return "document is missing required content";
	return `document conversion failed: ${error.message.slice(0, 200)}`;
}
