import { citationId } from "../core/text.ts";
import type { searchCorpus } from "../corpus/index.ts";
import type { SearchInput } from "./args.ts";

export type SearchMatch = {
	corpusDir: string;
	match: Awaited<ReturnType<typeof searchCorpus>>["matches"][number];
};

export type SearchResult = {
	matches: SearchMatch[];
	corporaScanned: number;
	corporaSearched: number;
	corporaSkipped: number;
	corporaTruncated: boolean;
	truncated: boolean;
	limited: boolean;
	injectionFiltered: number;
};

export function jsonSearchResult(input: SearchInput, result: SearchResult) {
	return {
		matchCount: result.matches.length,
		outputDir: input.outputDir,
		query: input.query,
		all: input.all || undefined,
		corporaScanned: input.all ? result.corporaScanned : undefined,
		corporaSearched: input.all ? result.corporaSearched : undefined,
		corporaSkipped: input.all ? result.corporaSkipped : undefined,
		corpusScanTruncated: input.all ? result.corporaTruncated : undefined,
		injectionFiltered: result.injectionFiltered || undefined,
		moreMatches: result.limited,
		searchTruncated: result.truncated,
		matches: result.matches.map(({ corpusDir, match }) => {
			const item = {
				citationId: displayCitation(input, corpusDir, match),
				corpusDir: input.all ? corpusDir : undefined,
				path: match.record.outputPath,
				url: match.record.url,
				finalUrl: match.record.finalUrl,
				lineStart: match.lineStart,
				lineEnd: match.lineEnd,
				snippet: match.text,
			};
			const titled = match.record.title
				? { ...item, title: match.record.title }
				: item;
			const kinded = match.record.kind
				? { ...titled, kind: match.record.kind }
				: titled;
			const warned = match.record.qualityReasons?.length
				? { ...kinded, qualityReasons: match.record.qualityReasons }
				: kinded;
			return match.record.injectionSignals.length
				? { ...warned, injectionSignals: match.record.injectionSignals }
				: warned;
		}),
	};
}

function displayCitation(
	input: SearchInput,
	corpusDir: string,
	match: SearchMatch["match"],
) {
	const id = citationId(
		match.record.outputPath,
		match.lineStart,
		match.lineEnd,
		match.contentHash,
	);
	return input.all ? `${corpusDir.replace(/\/+$/g, "")}/${id}` : id;
}
