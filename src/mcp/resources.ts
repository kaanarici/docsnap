import { runFiles } from "../output/files.ts";
import {
	corpusForResourceToken,
	corpusLimits,
	type McpState,
	readBoundedCorpusFile,
	resourceTokenForCorpus,
} from "./access.ts";
import { listCorpora, readPageSlice, readVerifiedManifest } from "./corpus.ts";
import { frameWebContent, mcpCorpusPagePath } from "./results.ts";

type ParsedResource =
	| { outputDir: string; kind: "summary" | "manifest" }
	| { outputDir: string; kind: "page"; outputPath: string };

export async function listResources(state: McpState) {
	const corpora = await listCorpora(
		"docsnap",
		corpusLimits.resourceCorpora,
		undefined,
		state.corpora,
	);
	const resources = [];
	for (const corpus of corpora.corpora) {
		const outputDir = corpus.output_dir;
		const token = await resourceTokenForCorpus(state, outputDir);
		resources.push(
			resource(token, "summary", "application/json"),
			resource(token, "manifest", "application/x-ndjson"),
		);
		try {
			const { records: pages } = await readVerifiedManifest(outputDir);
			for (const page of pages.slice(0, corpusLimits.resourcePagesPerCorpus)) {
				if (!page.ok || !page.outputPath) continue;
				resources.push({
					uri: resourceUri(token, "page", page.outputPath),
					name: `docsnap page: ${page.outputPath}`,
					description: page.url,
					mimeType: "text/markdown",
				});
			}
		} catch {}
	}
	return { resources };
}

export async function readResource(uri: string, state: McpState) {
	const parsed = await parseResourceUri(uri, state);
	if (parsed.kind === "page") {
		const page = await readPageSlice(parsed.outputDir, parsed.outputPath, {
			startLine: 1,
			maxChars: 25_000,
			includeFrontmatter: true,
		});
		return {
			contents: [
				{
					uri,
					mimeType: "text/markdown",
					text: frameWebContent({
						sourceUrl: page.record.url,
						finalUrl: page.record.finalUrl,
						corpusPath: mcpCorpusPagePath(parsed.outputDir, parsed.outputPath),
						injectionSignals: page.record.injectionSignals,
						body: page.text,
						truncated: page.truncated,
					}),
				},
			],
		};
	}
	await readVerifiedManifest(parsed.outputDir);
	const file = resourceFile(parsed.kind);
	const text = await readBoundedCorpusFile(
		parsed.outputDir,
		file,
		resourceReadLimit(parsed.kind),
	);
	return {
		contents: [
			{
				uri,
				mimeType: resourceMimeType(parsed.kind),
				text,
			},
		],
	};
}

function resource(
	outputDir: string,
	kind: ParsedResource["kind"],
	mimeType: string,
) {
	return {
		uri: resourceUri(outputDir, kind),
		name: `docsnap ${kind}: ${outputDir}`,
		description: `${kind} for ${outputDir}`,
		mimeType,
	};
}

function resourceUri(
	outputDir: string,
	kind: ParsedResource["kind"],
	page?: string,
) {
	const base = `docsnap://corpus/${encodeURIComponent(outputDir)}`;
	if (kind === "page") return `${base}/page/${encodeURIComponent(page ?? "")}`;
	return `${base}/${kind}`;
}

async function parseResourceUri(
	uri: string,
	state: McpState,
): Promise<ParsedResource> {
	let parsed: URL;
	try {
		parsed = new URL(uri);
	} catch {
		throw new Error("Invalid docsnap resource URI");
	}
	if (parsed.protocol !== "docsnap:" || parsed.hostname !== "corpus") {
		throw new Error("Invalid docsnap resource URI");
	}
	const parts = parsed.pathname.split("/").filter(Boolean);
	const [encodedOutputDir, kind, encodedPage] = parts;
	if (!encodedOutputDir || !kind)
		throw new Error("Invalid docsnap resource URI");
	const outputDir = decodeURIComponent(encodedOutputDir);
	const corpus = await corpusForResourceToken(state, outputDir);
	if (kind === "summary" || kind === "manifest") {
		return { outputDir: corpus, kind };
	}
	if (kind === "page" && encodedPage) {
		return {
			outputDir: corpus,
			kind,
			outputPath: decodeURIComponent(encodedPage),
		};
	}
	throw new Error("Invalid docsnap resource URI");
}

function resourceFile(kind: "summary" | "manifest") {
	if (kind === "summary") return runFiles.summary;
	return runFiles.manifest;
}

function resourceMimeType(kind: "summary" | "manifest") {
	if (kind === "summary") return "application/json";
	return "application/x-ndjson";
}

function resourceReadLimit(kind: "summary" | "manifest") {
	return kind === "manifest"
		? corpusLimits.manifestBytes
		: corpusLimits.resourceBytes;
}
