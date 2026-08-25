import { citationId, countLabel, terminalText } from "../core/text.ts";
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
		ok: true,
		matchCount: result.matches.length,
		outputDir: input.outputDir,
		query: input.query,
		all: input.all || undefined,
		corporaScanned: input.all ? result.corporaScanned : undefined,
		corporaSearched: input.all ? result.corporaSearched : undefined,
		corporaSkipped: input.all ? result.corporaSkipped : undefined,
		corporaTruncated: input.all ? result.corporaTruncated : undefined,
		injectionFiltered: result.injectionFiltered || undefined,
		limited: result.limited,
		truncated: result.truncated,
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

export function textSearchResult(input: SearchInput, result: SearchResult) {
	const scope = input.all
		? `${countLabel(result.corporaScanned, "valid corpus", "valid corpora")} under ${input.outputDir}`
		: input.outputDir;
	const lines = [`docsnap: ${result.matches.length} matches in ${scope}`];
	if (result.corporaSkipped) {
		lines.push(
			`docsnap: skipped ${countLabel(result.corporaSkipped, "unreadable or invalid corpus dir")}`,
		);
	}
	if (result.truncated || result.corporaTruncated) {
		lines.push("docsnap: search truncated by corpus scan or read limits");
	}
	if (result.limited) {
		lines.push("docsnap: more ranked matches available beyond --limit");
	}
	if (result.injectionFiltered) {
		lines.push(
			`docsnap: excluded ${countLabel(result.injectionFiltered, "concealed-injection page")}`,
		);
	}
	for (const { corpusDir, match } of result.matches) {
		lines.push(
			"",
			displayCitation(input, corpusDir, match),
			...(input.all ? [`corpus: ${corpusDir}`] : []),
			`path: ${match.record.outputPath}`,
			`lines: ${match.lineStart}-${match.lineEnd}`,
			`url: ${match.record.url}`,
			...(match.record.finalUrl !== match.record.url
				? [`finalUrl: ${match.record.finalUrl}`]
				: []),
		);
		if (match.record.title) lines.push(`title: ${match.record.title}`);
		if (match.record.kind) lines.push(`kind: ${match.record.kind}`);
		if (match.record.qualityReasons?.length) {
			lines.push(`warning: ${match.record.qualityReasons.join(", ")}`);
		}
		if (match.record.injectionSignals.length) {
			lines.push(
				`injectionSignals: ${match.record.injectionSignals.join(", ")}`,
			);
		}
		lines.push("", match.text.trimEnd());
	}
	return terminalText(`${lines.join("\n")}\n`);
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
