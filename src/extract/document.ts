import type { FetchedUrl } from "../core/types.ts";
import { failedRecord, recordFromExtracted } from "./page-record.ts";
import { titleFromMarkdown } from "./title.ts";

export async function extractDocument(input: FetchedUrl) {
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
		let markdown: string;
		const inspector =
			format === anydoc.Format.pdf ? await loadPdfInspector() : undefined;
		if (format === anydoc.Format.pdf) {
			if (!inspector) {
				return failedRecord(
					result,
					input.source,
					"PDF inspection is unavailable on this platform",
					"extract",
					input.wasSeed,
				);
			}
			const pdf = await inspector.processPdfAsync(Buffer.from(bytes));
			if (pdf.pagesNeedingOcr.length > 0) {
				const pages = pdf.pagesNeedingOcr.slice(0, 12).join(", ");
				const omitted = pdf.pagesNeedingOcr.length - 12;
				return failedRecord(
					result,
					input.source,
					`PDF pages ${pages}${omitted > 0 ? ` and ${omitted} more` : ""} of ${pdf.pageCount} require OCR`,
					"extract",
					input.wasSeed,
				);
			}
			if (!pdf.markdown) throw new Error("PDF contains no extractable text");
			markdown = pdf.markdown;
		} else {
			markdown = await anydoc.toMarkdownBytes(bytes, format, { ocr: "reject" });
		}
		const record = recordFromExtracted(
			input,
			{
				markdown,
				extractor: "markdown",
				title: titleFromMarkdown(markdown, path.replace(/\.[^./]+$/, "")),
			},
			"binary",
		);
		return record;
	} catch (error) {
		const failure = error instanceof Error ? error : new Error(String(error));
		return failedRecord(
			result,
			input.source,
			documentError(failure, path),
			"code" in failure && failure.code === "resourceLimit"
				? "too_large"
				: "extract",
			input.wasSeed,
		);
	}
}

async function loadPdfInspector() {
	if (process.platform === "darwin" && process.arch === "x64") return;
	return import("@firecrawl/pdf-inspector");
}

function documentError(error: Error, path: string) {
	const code = "code" in error ? error.code : undefined;
	if (code === "needsOcr") return "PDF contains pages that require OCR";
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
