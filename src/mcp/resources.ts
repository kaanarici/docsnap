import { runFiles } from "../output/files.ts";
import {
	corpusForResourceToken,
	corpusLimits,
	type McpState,
	resourceTokenForCorpus,
} from "./access.ts";
import {
	listCorpora,
	readCorpusFile,
	readManifest,
	readPageSlice,
} from "./corpus.ts";
import { frameWebContent } from "./results.ts";

type ParsedResource =
	| { outputDir: string; kind: "summary" | "tree" | "agent-readme" }
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
			resource(token, "tree", "text/plain"),
			resource(token, "agent-readme", "text/markdown"),
		);
		try {
			for (const page of (await readManifest(outputDir)).slice(
				0,
				corpusLimits.resourcePagesPerCorpus,
			)) {
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
						corpusPath: `${parsed.outputDir}/${parsed.outputPath}`,
						injectionSignals: page.record.injectionSignals,
						body: page.text,
						truncated: page.truncated,
					}),
				},
			],
		};
	}
	const file = resourceFile(parsed.kind);
	const text = await readCorpusFile(
		parsed.outputDir,
		file,
		corpusLimits.resourceBytes,
	);
	return {
		contents: [
			{
				uri,
				mimeType: parsed.kind === "summary" ? "application/json" : "text/plain",
				text: parsed.kind === "summary" ? text : capResourceText(text),
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
	if (kind === "summary" || kind === "tree" || kind === "agent-readme") {
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

function resourceFile(kind: "summary" | "tree" | "agent-readme") {
	if (kind === "summary") return runFiles.summary;
	if (kind === "tree") return runFiles.tree;
	return runFiles.agentReadme;
}

function capResourceText(text: string) {
	return text.length > corpusLimits.resourceChars
		? `${text.slice(0, corpusLimits.resourceChars)}\n[docsnap: resource truncated]`
		: text;
}
