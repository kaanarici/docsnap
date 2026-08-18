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
	if (result.next_cursor) {
		lines.push(`docsnap: next cursor ${result.next_cursor}`);
	}
	for (const corpus of result.corpora) {
		const mode = corpus.capture_mode ?? "unknown";
		lines.push(
			"",
			`${corpus.output_dir}  ${corpus.status}  ${mode}  ${countLabel(corpus.written, "page")}`,
			`  captured: ${corpus.generated_at}`,
			...issueLines(corpus),
			`  seed: ${corpus.seed_url}`,
		);
	}
	return terminalText(`${lines.join("\n")}\n`);
}

function issueLines(corpus: ListEntry) {
	const issues = [
		countIssue("failed", corpus.failed),
		countIssue("low_quality", corpus.low_quality),
		countIssue("quality_warnings", corpus.quality_warnings),
		countIssue("injection", corpus.injection_signal_pages),
		corpus.seed_failure_kind ? `failureKind=${corpus.seed_failure_kind}` : "",
		corpus.max_reached ? "max_reached" : "",
	].filter(Boolean);
	return issues.length ? [`  issues: ${issues.join(", ")}`] : [];
}

function countIssue(label: string, count: number) {
	return count > 0 ? `${label}=${count}` : "";
}
