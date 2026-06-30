import { join } from "node:path";
import { shellArg } from "../core/text.ts";
import { siteDiscoverySeedUrl } from "../core/url.ts";
import { runFiles } from "./files.ts";

const rawSearchStopWords = new Set(
	"a an and are as at be by can could did do does for from how i in is it me of on or the these this to up use what when where which who why with would you your".split(
		" ",
	),
);
export const maxRawSearchCommandDirs = 16;

type CorpusCommandInput = {
	seedUrl: string;
	outputDir: string;
	captureMode: "page" | "site";
	written: number;
	maxReached: boolean;
	maxPages: number;
	seedOutputPath?: string;
	retryCapture?: boolean;
	siteRetry?: boolean;
};

export function captureMoreCommand(
	seedUrl: string,
	outputDir: string,
	captureMode: "page" | "site",
	maxPages: number,
) {
	const modeFlag = captureMode === "page" ? "--page" : "--site";
	return `docsnap ${shellArg(seedUrl)} -o ${shellArg(outputDir)} ${modeFlag} -m ${maxPages}`;
}

export function retryCaptureCommand(
	seedUrl: string,
	outputDir: string,
	captureMode: "page" | "site",
	maxPages: number,
) {
	const parts = [
		"docsnap",
		shellArg(seedUrl),
		"-o",
		shellArg(outputDir),
		captureMode === "page" ? "--page" : "--site",
	];
	if (captureMode === "site") parts.push("-m", String(maxPages));
	return parts.join(" ");
}

export function captureSiteCommand(
	seedUrl: string,
	outputDir: string,
	maxPages: number,
) {
	return retryCaptureCommand(
		siteDiscoverySeedUrl(seedUrl),
		outputDir,
		"site",
		maxPages,
	);
}

export function searchCorpusCommand(corpusDir: string, query = "<term>") {
	return `docsnap search ${shellArg(corpusDir)} -- ${shellArg(query)}`;
}

export function searchAllCommand(rootDir: string, query = "<term>") {
	return `docsnap search ${shellArg(rootDir)} --all -- ${shellArg(query)}`;
}

export function fetchCorpusCommand(
	url: string,
	corpusDir: string,
	scope?: "page" | "site",
	question?: string,
	maxPages?: number,
	freshness?: "auto" | "reuse" | "refresh" | "force",
) {
	const parts = ["docsnap", "fetch", shellArg(url), "-o", shellArg(corpusDir)];
	if (scope) parts.push("--scope", scope);
	if (maxPages !== undefined) parts.push("-m", String(maxPages));
	if (freshness) parts.push("--freshness", freshness);
	if (question !== undefined) parts.push("--", shellArg(question));
	return parts.join(" ");
}

export function corpusMismatchCommands(input: {
	url: string;
	outputDir: string;
	question?: string;
	scope?: "page" | "site";
	maxPages?: number;
}) {
	const question = input.question ?? "<question>";
	const searchTerm = input.question ?? "<term>";
	return {
		search_existing: searchCorpusCommand(input.outputDir, searchTerm),
		raw_search_existing: rawSearchCommand(input.outputDir, searchTerm),
		force_replace: fetchCorpusCommand(
			input.url,
			input.outputDir,
			input.scope,
			question,
			input.maxPages,
			"force",
		),
		fetch_new: fetchCorpusCommand(
			input.url,
			`${input.outputDir}-new`,
			input.scope,
			question,
			input.maxPages,
		),
	};
}

export function rawSearchCommand(
	corpusDir: string | string[],
	query = "<term>",
	pathGlob?: string,
) {
	const glob = pathGlob ? ` -g ${shellArg(pathGlob)}` : "";
	const patterns = rawSearchPatterns(query)
		.map((term) => `-e ${shellArg(term)}`)
		.join(" ");
	const dirs = (Array.isArray(corpusDir) ? corpusDir : [corpusDir])
		.map(shellArg)
		.join(" ");
	return `rg -n --fixed-strings --ignore-case -g '*.md'${glob} ${patterns} -- ${dirs}`;
}

function rawSearchPatterns(query: string): string[] {
	const terms = query.trim().split(/\s+/).map(rawSearchTerm).filter(Boolean);
	const meaningful = terms.filter((term) => !rawSearchStopWords.has(term));
	const selected = meaningful.length ? meaningful : terms;
	return [...new Set((selected.length ? selected : ["<term>"]).slice(0, 8))];
}

function rawSearchTerm(value: string): string {
	if (value === "<term>") return value;
	return value
		.toLowerCase()
		.replace(/^[^a-z0-9_./@+#$<>:-]+|[^a-z0-9_./@+#$<>:-]+$/g, "");
}

export function corpusFilesCommand(corpusDir: string) {
	return `rg --files ${shellArg(corpusDir)} -g '*.md' | sort`;
}

export function inspectSummaryCommand(corpusDir: string) {
	return `cat ${shellArg(join(corpusDir, runFiles.summary))}`;
}

export function refreshCorpusCommand(corpusDir: string) {
	return `docsnap refresh ${shellArg(corpusDir)}`;
}

export function listCorporaCommand(
	rootDir: string,
	cursor: string,
	limit: number,
	json = false,
) {
	return `docsnap list ${shellArg(rootDir)} --cursor ${shellArg(cursor)} --limit ${limit}${json ? " --json" : ""}`;
}

export function expandLinesCommand(
	path: string,
	lineStart: number,
	lineEnd: number,
) {
	return `sed -n '${lineStart},${lineEnd}p' ${shellArg(path)}`;
}

export function corpusCommands(corpus: CorpusCommandInput) {
	if (corpus.written === 0) {
		return {
			inspect_summary: inspectSummaryCommand(corpus.outputDir),
			...(corpus.retryCapture !== false
				? {
						retry_capture: retryCaptureCommand(
							corpus.seedUrl,
							corpus.outputDir,
							corpus.captureMode,
							corpus.maxPages,
						),
					}
				: {}),
			...(corpus.captureMode === "page" && corpus.siteRetry !== false
				? {
						capture_site: captureSiteCommand(
							corpus.seedUrl,
							corpus.outputDir,
							corpus.maxPages,
						),
					}
				: {}),
		};
	}
	return {
		files: corpusFilesCommand(corpus.outputDir),
		...(corpus.seedOutputPath
			? {
					read_seed: expandLinesCommand(
						join(corpus.outputDir, corpus.seedOutputPath),
						1,
						200,
					),
				}
			: {}),
		raw_search: rawSearchCommand(corpus.outputDir),
		...(corpus.maxReached
			? {
					capture_more: captureMoreCommand(
						corpus.seedUrl,
						corpus.outputDir,
						corpus.captureMode,
						corpus.maxPages,
					),
				}
			: {}),
		fetch: fetchCorpusCommand(
			corpus.seedUrl,
			corpus.outputDir,
			corpus.captureMode,
			"<question>",
		),
		search: searchCorpusCommand(corpus.outputDir),
		refresh: refreshCorpusCommand(corpus.outputDir),
	};
}
