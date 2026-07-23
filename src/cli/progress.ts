import { join } from "node:path";
import { countLabel } from "../core/text.ts";
import type { RunSummary } from "../core/types.ts";
import { runFiles } from "../output/files.ts";

export function logLine(message: string): void {
	process.stderr.write(`${message}\n`);
}

export function printSummary(summary: RunSummary): void {
	const seconds = (summary.elapsedMs / 1000).toFixed(2);
	logLine(
		`docsnap: ${countLabel(summary.written, "page")} ${summaryAction(summary)} in ${seconds}s`,
	);
	if (summary.refresh.enabled) logLine(refreshLine(summary));
	if (summary.maxAppliesTo === "non-llms" && summary.written > summary.max) {
		logLine(
			`docsnap: llms.txt corpus included ${countLabel(summary.written, "page")}`,
		);
	}
	if (summary.maxReached) {
		logLine(`docsnap: page limit ${summary.max} reached`);
	}
	const assetWarning = summary.warnings.find(
		(warning) => warning.kind === "asset_recovery_truncated",
	);
	if (assetWarning) logLine(`docsnap: warning ${assetWarning.message}`);
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
	if (summary.hostRedirects) {
		logLine(
			`docsnap: ${countLabel(summary.hostRedirects, "page")} changed host via redirect`,
		);
	}
	if (!summary.dryRun) {
		logLine(`docsnap: summary ${artifactPath(summary, runFiles.summary)}`);
		logLine(`docsnap: manifest ${artifactPath(summary, runFiles.manifest)}`);
	}
	if (summary.seed.failureKind || summary.seed.error) {
		logLine(
			`docsnap: seed failure ${summary.seed.failureKind ?? "unknown"}${summary.seed.error ? `: ${summary.seed.error}` : ""}`,
		);
	}
}

function artifactPath(summary: RunSummary, file: string) {
	return join(outputDir(summary), file);
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
	if (summary.refresh.enabled) return `current in ${outputDir(summary)}`;
	return `written to ${outputDir(summary)}`;
}

function refreshLine(summary: RunSummary) {
	const refresh = summary.refresh;
	return `docsnap: refresh new=${refresh.new} changed=${refresh.changed} unchanged=${refresh.unchanged} removed=${refresh.removed} skipped_writes=${refresh.skippedWrites}`;
}

function failureSummary(summary: RunSummary) {
	return Object.entries(summary.byFailureKind)
		.map(([kind, count]) => `${kind}=${count}`)
		.join(" ");
}
