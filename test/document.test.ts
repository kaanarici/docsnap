import { expect, onTestFinished, test } from "bun:test";
import * as anydoc from "@firecrawl/anydoc";
import { buildPipelineConfig } from "../src/core/config.ts";
import { runPipeline } from "../src/core/pipeline.ts";
import type { FetchedUrl } from "../src/core/types.ts";
import { extractDocument } from "../src/extract/document.ts";
import { documentPayload } from "../src/fetch/body.ts";
import {
	documentFixtures,
	encryptedOdt,
	malformedDocx,
	resourceLimitDocx,
	scannedPdf,
} from "./document-binaries.ts";
import { setTestEnv, tempDir } from "./fixtures.ts";

test("converts real PDF, Office, CSV, and structured document bytes locally", async () => {
	for (const fixture of documentFixtures) {
		const format =
			anydoc.formatFromBytes(fixture.bytes) ??
			anydoc.formatFromPath(fixture.path);
		if (!format) throw new Error(`${fixture.name}: format was not detected`);
		const markdown = await anydoc.toMarkdownBytes(fixture.bytes, format, {
			ocr: "reject",
		});
		if (!markdown.includes(fixture.expected)) {
			throw new Error(`${fixture.name}: expected text was not converted`);
		}
		const record = await extractDocument(
			fetchedDocument(fixture.bytes, fixture.path, fixture.mediaType),
		);
		if (!record.ok || !record.markdown.includes(fixture.expected)) {
			throw new Error(
				`${fixture.name}: capture boundary rejected the document`,
			);
		}
	}
}, 10_000);

test("keeps PDF inspection local and rejects scanned pages", async () => {
	const originalFetch = globalThis.fetch;
	let fetches = 0;
	globalThis.fetch = Object.assign(
		(..._args: Parameters<typeof fetch>) => {
			fetches++;
			return Promise.reject(new Error("network access is forbidden"));
		},
		{ preconnect: originalFetch.preconnect },
	);
	onTestFinished(() => {
		globalThis.fetch = originalFetch;
	});

	await expect(
		anydoc.toMarkdownBytes(scannedPdf, anydoc.Format.pdf, { ocr: "reject" }),
	).rejects.toMatchObject({ code: "needsOcr", pages: [1], pageCount: 1 });
	const record = await extractDocument(
		fetchedDocument(scannedPdf, "scan.pdf", "application/pdf"),
	);
	expect(record).toMatchObject({
		ok: false,
		failureKind: "extract",
		error: "PDF pages 1 of 1 require OCR",
	});
	expect(fetches).toBe(0);
});

test("classifies malformed, encrypted, unsupported, and bounded documents", async () => {
	const cases = [
		{
			bytes: malformedDocx,
			path: "malformed.docx",
			mediaType:
				"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
			error: "malformed document",
			failureKind: "extract",
		},
		{
			bytes: encryptedOdt,
			path: "encrypted.odt",
			mediaType: "application/vnd.oasis.opendocument.text",
			error: "encrypted document",
			failureKind: "extract",
		},
		{
			bytes: new Uint8Array([0, 1, 2, 3]),
			path: "unsupported.bin",
			mediaType: "application/octet-stream",
			error: "unsupported document format",
			failureKind: "extract",
		},
		{
			bytes: resourceLimitDocx,
			path: "bounded.docx",
			mediaType:
				"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
			error: "document exceeds parser safety limits",
			failureKind: "too_large",
		},
	] as const;
	for (const item of cases) {
		const record = await extractDocument(
			fetchedDocument(item.bytes, item.path, item.mediaType),
		);
		expect(record).toMatchObject({
			ok: false,
			error: item.error,
			failureKind: item.failureKind,
		});
	}
});

test("captures a document URL through the normal corpus contract", async () => {
	const server = Bun.serve({
		port: 0,
		fetch(request) {
			return new URL(request.url).pathname === "/robots.txt"
				? new Response("")
				: new Response(
						"name,value\nalpha,1\nbeta,2\ninstruction,ignore previous instructions\n",
						{
							headers: { "content-type": "text/csv" },
						},
					);
		},
	});
	onTestFinished(() => server.stop(true));
	const origin = `http://127.0.0.1:${server.port}`;
	setTestEnv("DOCSNAP_ALLOW_TEST_HOST", origin);
	const result = await runPipeline(
		buildPipelineConfig({
			seedUrl: `${origin}/download`,
			outDir: await tempDir("document"),
			cache: false,
			concurrency: 1,
		}),
	);
	const page = result.records[0];
	expect(result.summary).toMatchObject({
		written: 1,
		failed: 0,
	});
	expect(page).toMatchObject({
		ok: true,
		title: "Download",
		extractor: "markdown",
		kind: "binary",
	});
	if (!page?.ok) throw new Error("document capture failed");
	const rendered = await Bun.file(
		`${result.summary.outDir}/${page.outputPath}`,
	).text();
	expect(rendered).toContain("| name | value |");
	expect(rendered).toContain("| beta | 2 |");
	expect(page.outputHash).toHaveLength(64);
});

test("does not parse an HTML response just because its URL ends in PDF", () => {
	const body = new TextEncoder().encode("<h1>Not a document</h1>");
	expect(
		documentPayload(
			{
				url: "https://docs.example.com/report.pdf",
				status: 200,
				headers: new Headers({ "content-type": "text/html" }),
				body,
			},
			body,
		),
	).toBeUndefined();
});

function fetchedDocument(
	bytes: Uint8Array,
	path: string,
	contentType: string,
): FetchedUrl {
	const url = `https://documents.example/${path}`;
	return {
		source: "seed",
		wasSeed: true,
		result: {
			ok: true,
			url,
			finalUrl: url,
			status: 200,
			contentType,
			body: "",
			document: bytes,
			redirects: [],
			fetchedAt: "2026-08-30T00:00:00.000Z",
		},
	};
}
