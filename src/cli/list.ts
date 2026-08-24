import { isAbsolute } from "node:path";
import { countLabel, terminalText } from "../core/text.ts";
import { listCorpora } from "../corpus/index.ts";
import type { ListInput } from "./args.ts";

export async function runList(input: ListInput): Promise<void> {
	const result = await listCorpora(input.rootDir, input.limit, input.cursor, {
		allowAbsoluteRoot: true,
		preserveAbsolutePaths: isAbsolute(input.rootDir),
	});
	const output = {
		ok: true,
		rootDir: input.rootDir,
		...result,
	};
	process.stdout.write(
		input.json ? `${JSON.stringify(output)}\n` : textResult(input, result),
	);
}

type ListResult = Awaited<ReturnType<typeof listCorpora>>;
type ListEntry = ListResult["corpora"][number];

function textResult(input: ListInput, result: ListResult) {
	const lines = [
		`docsnap: ${countLabel(result.corpora.length, "valid corpus", "valid corpora")} under ${input.rootDir}`,
	];
	if (result.corpora.length === 0) {
		lines.push("docsnap: no valid corpora found");
	}
	if (result.truncated) lines.push("docsnap: corpus scan truncated");
	if (result.corporaSkipped) {
		lines.push(
			`docsnap: skipped ${countLabel(result.corporaSkipped, "unreadable or invalid corpus dir")}`,
		);
	}
	if (result.nextCursor) {
		lines.push(`docsnap: next cursor ${result.nextCursor}`);
	}
	for (const corpus of result.corpora) {
		const mode = corpus.captureMode ?? "unknown";
		lines.push(
			"",
			`${corpus.outputDir}  ${corpus.status}  ${mode}  ${countLabel(corpus.written, "page")}`,
			`  captured: ${corpus.generatedAt}`,
			...issueLines(corpus),
			`  seed: ${corpus.seedUrl}`,
		);
	}
	return terminalText(`${lines.join("\n")}\n`);
}

function issueLines(corpus: ListEntry) {
	const issues = [
		countIssue("failed", corpus.failed),
		countIssue("low_quality", corpus.lowQuality),
		countIssue("quality_warnings", corpus.qualityWarnings),
		countIssue("injection", corpus.injectionSignalPages),
		corpus.seedFailureKind ? `failureKind=${corpus.seedFailureKind}` : "",
		corpus.maxReached ? "max_reached" : "",
	].filter(Boolean);
	return issues.length ? [`  issues: ${issues.join(", ")}`] : [];
}

function countIssue(label: string, count: number) {
	return count > 0 ? `${label}=${count}` : "";
}
