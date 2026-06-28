import { join } from "node:path";
import { citationId } from "../core/citation.ts";
import { countLabel, shellArg } from "../core/text.ts";
import type { searchCorpus } from "../mcp/corpus.ts";
import {
	expandLinesCommand,
	maxRawSearchCommandDirs,
	rawSearchCommand,
} from "../output/commands.ts";
import { maxSearchResults, type SearchInput } from "./args.ts";

export type CappedCorpus = {
	outputDir: string;
	seedUrl: string;
	command: string;
};

export type EmptyCorpus = {
	outputDir: string;
	seedUrl: string;
	commands: { inspect_summary: string; retry_capture?: string } & {
		capture_site?: string;
	};
};

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
	pagesSkipped: number;
	injectionFiltered: number;
	rawSearchDirs: string[];
	cappedCorpora: CappedCorpus[];
	emptyCorpora: EmptyCorpus[];
};

export function jsonSearchResult(input: SearchInput, result: SearchResult) {
	const raw = actionableRawSearch(input, result);
	const actions = nextActions(input, result, raw);
	const emptyCommands =
		result.matches.length === 0 &&
		result.emptyCorpora.length === 1 &&
		!input.all
			? result.emptyCorpora[0]!.commands
			: undefined;
	const cappedCommand =
		result.cappedCorpora.length === 1
			? result.cappedCorpora[0]!.command
			: undefined;
	return {
		ok: true,
		matchCount: result.matches.length,
		outputDir: input.outputDir,
		query: input.query,
		all: input.all,
		...(raw || emptyCommands || cappedCommand
			? {
					commands: {
						...(raw ? { raw_search: raw } : {}),
						...(cappedCommand ? { capture_more: cappedCommand } : {}),
						...emptyCommands,
					},
				}
			: {}),
		...(result.cappedCorpora.length
			? { cappedCorpora: result.cappedCorpora }
			: {}),
		...(result.matches.length === 0 && result.emptyCorpora.length
			? { emptyCorpora: result.emptyCorpora }
			: {}),
		corporaScanned: result.corporaScanned,
		corporaSearched: result.corporaSearched,
		corporaSkipped: result.corporaSkipped,
		corporaTruncated: result.corporaTruncated,
		pagesSkipped: result.pagesSkipped,
		injectionFiltered: result.injectionFiltered,
		limited: result.limited,
		matches: result.matches.map(({ corpusDir, match }) => ({
			citationId: displayCitation(input, corpusDir, match),
			corpusDir,
			outputPath: match.record.outputPath,
			url: match.record.url,
			finalUrl: match.record.finalUrl,
			...(match.record.title
				? { untrusted_web_title: match.record.title }
				: {}),
			lineStart: match.lineStart,
			lineEnd: match.lineEnd,
			expand: sedCommand(corpusDir, match),
			score: roundScore(match.score),
			confidence: match.confidence,
			extractor: match.extractor,
			contentHash: match.contentHash,
			...(match.record.injectionSignals.length
				? { injectionSignals: match.record.injectionSignals }
				: {}),
			untrusted_web_content: true,
			snippet: match.text,
		})),
		truncated: result.truncated,
		...(actions.length ? { next_actions: actions } : {}),
	};
}

export function textSearchResult(input: SearchInput, result: SearchResult) {
	const scope = input.all
		? `${countLabel(result.corporaScanned, "valid corpus", "valid corpora")} under ${input.outputDir}`
		: input.outputDir;
	const lines = [`docsnap: ${result.matches.length} matches in ${scope}`];
	const raw = actionableRawSearch(input, result);
	const actions = nextActions(input, result, raw);
	if (input.all && result.corporaScanned === 0) {
		lines.push("docsnap: no valid corpora found; run docsnap <url> first");
	}
	if (input.all && result.corporaSearched !== result.corporaScanned) {
		lines.push(
			`docsnap: searched retained pages from ${result.corporaSearched} corpus dirs`,
		);
	}
	if (result.corporaSkipped) {
		lines.push(
			`docsnap: skipped ${countLabel(result.corporaSkipped, "unreadable or invalid corpus dir")}`,
		);
	}
	if (result.truncated || result.corporaTruncated) {
		lines.push("docsnap: search truncated by corpus scan or read limits");
	}
	if (result.pagesSkipped) {
		lines.push(
			`docsnap: skipped ${countLabel(result.pagesSkipped, "missing or unreadable page body", "missing or unreadable page bodies")}`,
		);
	}
	if (result.limited)
		lines.push("docsnap: more ranked matches available beyond --limit");
	if (result.injectionFiltered) {
		lines.push(
			`docsnap: excluded ${countLabel(result.injectionFiltered, "injection-signal candidate page")}`,
		);
	}
	if (raw) lines.push(`docsnap: raw search with ${raw}`);
	lines.push(...actions.map((action) => `docsnap: ${action}`));
	for (const { corpusDir, match } of result.matches) {
		lines.push(
			"",
			displayCitation(input, corpusDir, match),
			...(input.all ? [`corpus: ${corpusDir}`] : []),
			`url: ${match.record.url}`,
			...(match.record.finalUrl !== match.record.url
				? [`finalUrl: ${match.record.finalUrl}`]
				: []),
			`score: ${roundScore(match.score)}; confidence: ${match.confidence}; extractor: ${match.extractor}`,
			`expand: ${sedCommand(corpusDir, match)}`,
		);
		if (match.record.title)
			lines.push(`untrusted title: ${match.record.title}`);
		if (match.record.injectionSignals.length) {
			lines.push(`injection: ${match.record.injectionSignals.join(", ")}`);
		}
		lines.push("", match.text.trimEnd());
	}
	return `${lines.join("\n")}\n`;
}

function nextActions(
	input: SearchInput,
	result: SearchResult,
	rawCommand?: string,
): string[] {
	const rawOmitted = rawSearchOmittedActions(input, result);
	const limited = limitedSearchActions(input, result);
	if (
		result.matches.length > 0 &&
		!result.truncated &&
		!result.corporaTruncated
	)
		return [
			...limited,
			...skippedPageActions(input, result),
			...cappedCorpusActions(result.cappedCorpora),
			...rawOmitted,
		];
	if (result.matches.length === 0) {
		if (result.corporaScanned === 0) {
			return [
				"Capture a public docs URL with docsnap <url>.",
				"Or fetch cited context in one step with docsnap fetch <url> -- <question>.",
			];
		}
		if (result.corporaSearched === 0) {
			const actions = noSearchablePageActions(input, result);
			if (actions.length) {
				actions.push(...emptyCorpusActions(result.emptyCorpora));
				actions.push(...cappedCorpusActions(result.cappedCorpora));
				return actions;
			}
			if (result.emptyCorpora.length > 0)
				return emptyCorpusActions(result.emptyCorpora);
		}
		const actions = cappedCorpusActions(result.cappedCorpora);
		actions.push(
			rawCommand
				? `no ranked hits in captured pages; try broader terms or run ${rawCommand}`
				: "no ranked hits in captured pages; try broader terms",
		);
		actions.push(...skippedPageActions(input, result));
		actions.push(...emptyCorpusActions(result.emptyCorpora));
		actions.push(...rawOmitted);
		return actions;
	}
	const actions = rawCommand
		? [`search was truncated; narrow the query or run ${rawCommand}`]
		: ["search was truncated; narrow the query"];
	actions.push(...limited);
	actions.push(...skippedPageActions(input, result));
	actions.push(...rawOmitted);
	return actions;
}

function skippedPageActions(
	input: SearchInput,
	result: SearchResult,
): string[] {
	if (result.pagesSkipped === 0) return [];
	const refresh = input.all
		? "refresh or recapture stale corpora before relying on this local library"
		: `refresh or recapture this corpus with docsnap refresh ${shellArg(input.outputDir)}`;
	return [
		`${countLabel(result.pagesSkipped, "manifest page")} could not be read; ${refresh}`,
	];
}

function limitedSearchActions(
	input: SearchInput,
	result: SearchResult,
): string[] {
	if (!result.limited) return [];
	const nextLimit = Math.min(
		maxSearchResults,
		Math.max(input.limit + 1, input.limit * 2),
	);
	if (nextLimit > input.limit) {
		return [
			`more ranked matches available; rerun with ${searchWithLimitCommand(input, nextLimit)}`,
		];
	}
	return [
		`more ranked matches available beyond max --limit ${maxSearchResults}; narrow the query or use raw grep`,
	];
}

function noSearchablePageActions(
	input: SearchInput,
	result: SearchResult,
): string[] {
	if (result.corporaScanned === 0 || result.emptyCorpora.length > 0) return [];
	const actions: string[] = [];
	if (input.pathGlob) {
		actions.push(
			`no captured Markdown pages matched --glob ${JSON.stringify(input.pathGlob)}; use a broader --glob or omit it`,
		);
	}
	if (input.excludeInjection && result.injectionFiltered > 0) {
		actions.push(
			"all matching pages were excluded by --exclude-injection; rerun without it if you need flagged pages",
		);
	}
	return actions.length
		? actions
		: ["no searchable captured pages matched the filters"];
}

function actionableRawSearch(input: SearchInput, result: SearchResult) {
	if (input.all && result.corporaScanned === 0) return undefined;
	if (result.matches.length === 0 && result.corporaSearched === 0)
		return undefined;
	if (input.excludeInjection && result.injectionFiltered > 0) return undefined;
	if (input.all && result.rawSearchDirs.length > maxRawSearchCommandDirs)
		return undefined;
	return rawSearchCommand(result.rawSearchDirs, input.query, input.pathGlob);
}

function rawSearchOmittedActions(
	input: SearchInput,
	result: SearchResult,
): string[] {
	if (!input.all || result.rawSearchDirs.length <= maxRawSearchCommandDirs)
		return [];
	return [
		`raw grep command omitted because it spans ${countLabel(result.rawSearchDirs.length, "corpus dir")}; search a narrower root or use a matched corpusDir directly`,
	];
}

function cappedCorpusActions(corpora: CappedCorpus[]) {
	return corpora.map(
		(corpus) =>
			`coverage may be capped for ${corpus.outputDir}; run ${corpus.command}`,
	);
}

function emptyCorpusActions(corpora: EmptyCorpus[]) {
	return corpora.flatMap((corpus) => {
		const actions = [
			`no captured Markdown pages in ${corpus.outputDir}; inspect with ${corpus.commands.inspect_summary}`,
		];
		if (corpus.commands.retry_capture) {
			actions.push(`retry capture with ${corpus.commands.retry_capture}`);
		} else {
			actions.push("choose another reachable public docs URL");
		}
		if (corpus.commands.capture_site) {
			actions.push(
				`if the exact page is too narrow, try site discovery with ${corpus.commands.capture_site}`,
			);
		}
		return actions;
	});
}

function searchWithLimitCommand(input: SearchInput, limit: number) {
	const parts = ["docsnap", "search", shellArg(input.outputDir)];
	if (input.all) parts.push("--all");
	if (input.json) parts.push("--json");
	parts.push("--limit", String(limit));
	if (input.pathGlob) parts.push("--glob", shellArg(input.pathGlob));
	if (input.excludeInjection) parts.push("--exclude-injection");
	parts.push("--", shellArg(input.query));
	return parts.join(" ");
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
	return input.all ? `${trimTrailingSlash(corpusDir)}/${id}` : id;
}

function trimTrailingSlash(path: string) {
	return path.replace(/\/+$/g, "");
}

function sedCommand(corpusDir: string, match: SearchMatch["match"]) {
	return expandLinesCommand(
		join(corpusDir, match.record.outputPath),
		match.lineStart,
		match.lineEnd,
	);
}

function roundScore(score: number) {
	return Math.round(score * 1000) / 1000;
}
