import { isAbsolute } from "node:path";
import { nextCaptureMax } from "../core/config.ts";
import { countLabel } from "../core/text.ts";
import {
	retryCanHelpFailureKind,
	siteRetryCanHelpFailureKind,
} from "../core/types.ts";
import { listCorpora } from "../mcp/corpus.ts";
import {
	listCorporaCommand,
	maxRawSearchCommandDirs,
	rawSearchCommand,
	searchAllCommand,
	corpusCommands as sharedCorpusCommands,
} from "../output/commands.ts";
import type { ListInput } from "./args.ts";

export async function runList(input: ListInput): Promise<void> {
	const result = await listCorpora(
		input.rootDir,
		input.limit,
		input.cursor,
		[],
		{
			allowAbsoluteRoot: true,
			preserveAbsolutePaths: isAbsolute(input.rootDir),
		},
	);
	const output = {
		ok: true,
		rootDir: input.rootDir,
		...listCommands(input, result),
		...result,
		corpora: result.corpora.map(jsonCorpus),
		...(result.next_cursor
			? {
					next_command: listCorporaCommand(
						input.rootDir,
						result.next_cursor,
						input.limit,
						input.json,
					),
				}
			: {}),
		...jsonNextActions(input, result),
	};
	process.stdout.write(
		input.json ? `${JSON.stringify(output)}\n` : textResult(input, result),
	);
}

type ListResult = Awaited<ReturnType<typeof listCorpora>>;
type ListEntry = ListResult["corpora"][number];

function jsonNextActions(input: ListInput, result: ListResult) {
	const actions: string[] = [];
	if (result.corpora.length === 0) {
		if (result.corporaSkipped) {
			actions.push(
				"Recapture into a clean corpus directory or remove skipped invalid corpus directories before searching this local library.",
			);
		}
		actions.push(
			"Capture a public docs URL with docsnap <url>.",
			"Or fetch cited context in one step with docsnap fetch <url> -- <question>.",
		);
	}
	if (result.corpora.length > 0) {
		if (result.corpora.some((corpus) => corpus.written > 0)) {
			const commands = libraryCommands(input, result);
			if (commands?.search_all)
				actions.push(`Search all corpora with ${commands.search_all}.`);
			if (commands?.raw_search_all)
				actions.push(
					`Raw grep captured Markdown with ${commands.raw_search_all}.`,
				);
			const firstRead = firstCorpusCommand(result, "read_seed");
			if (firstRead)
				actions.push(`Read a captured seed page with ${firstRead}.`);
			const firstFetch = firstCorpusCommand(result, "fetch");
			if (firstFetch)
				actions.push(`Fetch cited context from a corpus with ${firstFetch}.`);
			actions.push(...rawSearchAllOmittedActions(result));
		}
		const captureMore = firstCorpusCommand(result, "capture_more");
		if (captureMore)
			actions.push(
				`Capture more pages for a capped corpus with ${captureMore}.`,
			);
		if (result.corpora.some((corpus) => corpus.written === 0)) {
			const inspectSummary = firstCorpusCommand(result, "inspect_summary");
			const retry = firstCorpusCommand(result, "retry_capture");
			const captureSite = firstCorpusCommand(result, "capture_site");
			actions.push(
				inspectSummary
					? `Inspect a zero-page corpus with ${inspectSummary}.`
					: "Inspect zero-page corpus summaries before retrying or choosing another URL.",
			);
			if (retry) actions.push(`Retry a zero-page capture with ${retry}.`);
			if (captureSite)
				actions.push(
					`Broaden an exact page corpus to site discovery with ${captureSite}.`,
				);
		}
	}
	if (result.next_cursor) {
		actions.push(
			`Continue listing with ${listCorporaCommand(input.rootDir, result.next_cursor, input.limit, input.json)}.`,
		);
	}
	return actions.length ? { next_actions: actions } : {};
}

type CorpusCommandKey =
	| "read_seed"
	| "fetch"
	| "capture_more"
	| "inspect_summary"
	| "retry_capture"
	| "capture_site";

function firstCorpusCommand(
	result: ListResult,
	key: CorpusCommandKey,
): string | undefined {
	for (const corpus of result.corpora) {
		const commands = corpusCommands(corpus);
		const command = commandByKey(commands, key);
		if (command) return command;
	}
	return undefined;
}

function commandByKey(
	commands: ReturnType<typeof corpusCommands>,
	key: CorpusCommandKey,
) {
	if (key === "read_seed" && "read_seed" in commands) return commands.read_seed;
	if (key === "fetch" && "fetch" in commands) return commands.fetch;
	if (key === "capture_more" && "capture_more" in commands)
		return commands.capture_more;
	if (key === "inspect_summary" && "inspect_summary" in commands)
		return commands.inspect_summary;
	if (key === "retry_capture" && "retry_capture" in commands)
		return commands.retry_capture;
	if (key === "capture_site" && "capture_site" in commands)
		return commands.capture_site;
	return undefined;
}

function textResult(input: ListInput, result: ListResult) {
	const lines = [
		`docsnap: ${countLabel(result.corpora.length, "valid corpus", "valid corpora")} under ${input.rootDir}`,
	];
	if (result.corpora.length === 0) {
		lines.push(
			result.corporaSkipped
				? "docsnap: no valid corpora found; recapture into a clean corpus dir or remove skipped invalid corpus dirs"
				: "docsnap: no valid corpora found; run docsnap <url> first",
		);
	}
	if (result.truncated) lines.push("docsnap: corpus scan truncated");
	if (result.corporaSkipped) {
		lines.push(
			`docsnap: skipped ${countLabel(result.corporaSkipped, "unreadable or invalid corpus dir")}`,
		);
	}
	if (result.next_cursor) {
		lines.push(
			`docsnap: more corpora; run ${listCorporaCommand(input.rootDir, result.next_cursor, input.limit)}`,
		);
	}
	const commands = libraryCommands(input, result);
	if (commands) {
		lines.push(`docsnap: search all with ${commands.search_all}`);
		if (commands.raw_search_all) {
			lines.push(`docsnap: raw search all with ${commands.raw_search_all}`);
		}
		lines.push(
			...rawSearchAllOmittedActions(result).map(
				(action) => `docsnap: ${action}`,
			),
		);
	}
	for (const corpus of result.corpora) {
		lines.push(
			"",
			corpusLine(corpus),
			`  captured: ${corpus.generated_at}`,
			...issueLines(corpus),
			`  seed: ${corpus.seed_url}`,
			...commandLines(corpus),
		);
	}
	return `${lines.join("\n")}\n`;
}

function listCommands(input: ListInput, result: ListResult) {
	const commands = libraryCommands(input, result);
	return commands ? { commands } : {};
}

function libraryCommands(input: ListInput, result: ListResult) {
	const searchableDirs = result.corpora
		.filter((corpus) => corpus.written > 0)
		.map((corpus) => corpus.output_dir);
	if (searchableDirs.length === 0) return undefined;
	return {
		search_all: searchAllCommand(input.rootDir),
		...(result.next_cursor || result.truncated
			? {}
			: searchableDirs.length <= maxRawSearchCommandDirs
				? { raw_search_all: rawSearchCommand(searchableDirs) }
				: {}),
	};
}

function rawSearchAllOmittedActions(result: ListResult) {
	if (result.next_cursor || result.truncated) return [];
	const searchableCount = result.corpora.filter(
		(corpus) => corpus.written > 0,
	).length;
	if (searchableCount <= maxRawSearchCommandDirs) return [];
	return [
		`raw grep command omitted because it spans ${countLabel(searchableCount, "corpus dir")}; search a narrower root or use a corpus output_dir directly`,
	];
}

function commandLines(corpus: ListEntry) {
	const commands = corpusCommands(corpus);
	if ("inspect_summary" in commands) {
		return [
			`  inspect: ${commands.inspect_summary}`,
			...("retry_capture" in commands
				? [`  retry: ${commands.retry_capture}`]
				: []),
			...(commands.capture_site
				? [`  site retry: ${commands.capture_site}`]
				: []),
		];
	}
	return [
		`  files: ${commands.files}`,
		...("read_seed" in commands ? [`  read seed: ${commands.read_seed}`] : []),
		`  raw search: ${commands.raw_search}`,
		...(commands.capture_more
			? [`  capture more: ${commands.capture_more}`]
			: []),
		`  fetch: ${commands.fetch}`,
		`  search: ${commands.search}`,
		`  refresh: ${commands.refresh}`,
	];
}

function jsonCorpus(corpus: ListEntry) {
	return {
		...corpus,
		commands: corpusCommands(corpus),
	};
}

function corpusCommands(corpus: ListEntry) {
	const nextMax = corpus.max_reached
		? nextCaptureMax(corpus.max_pages)
		: undefined;
	return sharedCorpusCommands({
		seedUrl: corpus.seed_url,
		outputDir: corpus.output_dir,
		captureMode: corpus.capture_mode,
		written: corpus.written,
		maxReached: nextMax !== undefined,
		maxPages: nextMax ?? corpus.max_pages,
		...(corpus.seed_output_path
			? { seedOutputPath: corpus.seed_output_path }
			: {}),
		retryCapture: retryCanHelpFailureKind(corpus.seed_failure_kind),
		siteRetry: siteRetryCanHelpFailureKind(corpus.seed_failure_kind),
	});
}

function corpusLine(corpus: ListEntry) {
	const mode = corpus.capture_mode ?? "unknown";
	return `${corpus.output_dir}  ${corpus.status}  ${mode}  ${countLabel(corpus.written, "page")}`;
}

function issueLines(corpus: ListEntry) {
	const issues = [
		countIssue("failed", corpus.failed),
		countIssue("low_quality", corpus.low_quality),
		countIssue("quality_warnings", corpus.quality_warnings),
		countIssue("injection", corpus.injection_signal_pages),
		corpus.max_reached ? "max_reached" : "",
	].filter(Boolean);
	return issues.length ? [`  issues: ${issues.join(", ")}`] : [];
}

function countIssue(label: string, count: number) {
	return count > 0 ? `${label}=${count}` : "";
}
