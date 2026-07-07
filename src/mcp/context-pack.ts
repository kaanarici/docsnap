import { searchCorpus } from "./corpus.ts";
import {
	mcpSnippetCitation,
	readPageNextAction,
	snippetFence,
	snippetFenceNote,
} from "./results.ts";
import type { RankedSnippet } from "./retrieval.ts";

type ContextPackOptions = {
	query: string;
	maxSnippets: number;
	contextChars: number;
	pathGlob?: string;
	excludeInjection: boolean;
	preferredOutputPaths?: readonly string[];
	coverageAction?: string | false;
};

export async function buildContextPack(
	outputDir: string,
	options: ContextPackOptions,
) {
	const { matches, truncated, limited, skipped } = await searchCorpus(
		outputDir,
		{
			query: options.query,
			...(options.pathGlob ? { pathGlob: options.pathGlob } : {}),
			maxResults: Math.min(options.maxSnippets * 2, 50),
			snippetChars: options.contextChars,
			excludeInjection: options.excludeInjection,
			genericWhenNoContentTerms: true,
			...(options.preferredOutputPaths
				? { preferredOutputPaths: options.preferredOutputPaths }
				: {}),
		},
	);
	const deduped = dedupe(matches);
	const fence = snippetFence();
	const citations = deduped
		.slice(0, options.maxSnippets)
		.map((match) => mcpSnippetCitation(match, fence));
	return {
		query: options.query,
		output_dir: outputDir,
		web_snippet_fence: fence,
		citation_count: citations.length,
		injection_excluded: options.excludeInjection,
		citations,
		truncated,
		limited: limited || deduped.length > options.maxSnippets,
		pages_skipped: skipped,
		next_actions: contextNextActions(
			outputDir,
			fence,
			citations[0],
			options.coverageAction,
		),
	};
}

type Citation = ReturnType<typeof mcpSnippetCitation>;

function contextNextActions(
	outputDir: string,
	fence: string,
	first?: Citation,
	coverageAction?: string | false,
): string[] {
	if (!first) {
		const actions = [
			"No citations matched this query; try broader terms or inspect captured pages before answering.",
		];
		if (coverageAction !== false) {
			actions.push(
				coverageAction ??
					"If the corpus is too small, capture a broader scope or a higher max_pages value.",
			);
		}
		return actions;
	}
	return [
		readPageNextAction(
			outputDir,
			first.output_path,
			first.line_start,
			first.line_end,
		),
		`Cite snippets by citation_id; ${snippetFenceNote(fence)}`,
	];
}

function dedupe(matches: RankedSnippet[]): RankedSnippet[] {
	const seen = new Set<string>();
	const out: RankedSnippet[] = [];
	for (const match of matches) {
		const key = match.contentHash || match.record.outputPath;
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(match);
	}
	return out;
}
