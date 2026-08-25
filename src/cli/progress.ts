import { join } from "node:path";
import { countLabel, terminalText } from "../core/text.ts";
import type { RunSummary } from "../core/types.ts";
import { runFiles } from "../output/files.ts";

export function logLine(message: string): void {
	process.stderr.write(`${terminalText(message)}\n`);
}

export function printSummary(summary: RunSummary): void {
	logLine(
		`docsnap: ${countLabel(summary.written, "page")} ${summaryAction(summary)}`,
	);
	if (summary.refresh) logLine(refreshLine(summary.refresh));
	if (summary.maxAppliesTo === "non-llms" && summary.written > summary.max) {
		logLine(
			`docsnap: llms.txt corpus included ${countLabel(summary.written, "page")}`,
		);
	}
	if (summary.maxReached) {
		logLine(`docsnap: page limit ${summary.max} reached`);
	}
	if (summary.stopReason === "rate_limited")
		logLine("docsnap: stopped after repeated HTTP 429 responses");
	else if (summary.discoveryTruncated)
		logLine("docsnap: warning discovery stopped at its safety budget");
	if (summary.render?.unavailable) {
		logLine(
			`docsnap: warning renderer unavailable: ${summary.render.unavailable}`,
		);
	} else if (summary.render?.truncated) {
		logLine("docsnap: warning rendering stopped at its safety budget");
	}
	if (summary.failed || summary.lowQuality) {
		const notFound = summary.byFailureKind.not_found ?? 0;
		const failed = summary.failed - notFound;
		logLine(issueSummary(failed, notFound, summary.lowQuality));
		const failures = failureSummary(summary);
		if (failures) logLine(`docsnap: failure kinds ${failures}`);
	}
	if (summary.qualityWarnings) {
		logLine(`docsnap: ${summary.qualityWarnings} quality warnings`);
	}
	if (summary.injectionSignalPages) {
		logLine(
			`docsnap: ${countLabel(summary.injectionSignalPages, "injection signal page", "injection signal pages")}`,
		);
	}
	if (!summary.dryRun) {
		logLine(`docsnap: summary ${join(outputDir(summary), runFiles.summary)}`);
		logLine(`docsnap: manifest ${join(outputDir(summary), runFiles.manifest)}`);
	}
	if (summary.seed.failureKind || summary.seed.error) {
		logLine(
			`docsnap: seed failure ${summary.seed.failureKind ?? "unknown"}${summary.seed.error ? `: ${summary.seed.error}` : ""}`,
		);
	}
}

function outputDir(summary: RunSummary) {
	return join(summary.outDir, ".");
}

function issueSummary(failed: number, notFound: number, lowQuality: number) {
	const parts: string[] = [];
	if (failed) parts.push(`${failed} failed`);
	if (notFound) parts.push(`${notFound} stale/not-found`);
	if (lowQuality) parts.push(`${lowQuality} low-quality`);
	return `docsnap: ${parts.join(", ")}`;
}

function summaryAction(summary: RunSummary) {
	if (summary.dryRun) return "found";
	if (summary.refresh) return `current in ${outputDir(summary)}`;
	return `written to ${outputDir(summary)}`;
}

function refreshLine(refresh: NonNullable<RunSummary["refresh"]>) {
	return `docsnap: refresh new=${refresh.new} changed=${refresh.changed} unchanged=${refresh.unchanged} removed=${refresh.removed}`;
}

function failureSummary(summary: RunSummary) {
	return Object.entries(summary.byFailureKind)
		.map(([kind, count]) => `${kind}=${count}`)
		.join(" ");
}
