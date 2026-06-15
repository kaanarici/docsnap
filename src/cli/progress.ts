import type { RunSummary } from "../core/types.ts";
import { runFiles } from "../output/files.ts";

export function logLine(message: string): void {
	process.stderr.write(`${message}\n`);
}

export function printSummary(summary: RunSummary): void {
	const seconds = (summary.elapsedMs / 1000).toFixed(2);
	logLine(
		`docsnap: ${summary.written} pages ${summary.dryRun ? "found" : `written to ${summary.outDir}`} in ${seconds}s`,
	);
	if (summary.maxAppliesTo === "non-llms" && summary.written > summary.max) {
		logLine(`docsnap: llms.txt corpus included ${summary.written} pages`);
	}
	if (summary.maxReached) {
		logLine(
			`docsnap: page limit reached; rerun with -m ${summary.max * 2} for more`,
		);
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
		logLine(`docsnap: ${summary.injectionSignalPages} injection signal pages`);
	}
	if (summary.hostRedirects) {
		const page = summary.hostRedirects === 1 ? "page" : "pages";
		logLine(
			`docsnap: ${summary.hostRedirects} ${page} changed host via redirect`,
		);
	}
	if (!summary.dryRun) {
		logLine(`docsnap: summary ${summary.outDir}/${runFiles.summary}`);
		logLine(`docsnap: manifest ${summary.outDir}/${runFiles.manifest}`);
		logLine(`docsnap: guide ${summary.outDir}/${runFiles.agentReadme}`);
	}
	if (summary.agentFilesUpdated) {
		logLine(
			summary.agentFilesUpdated.length
				? `docsnap: linked handoff from ${summary.agentFilesUpdated.join(", ")}`
				: "docsnap: no AGENTS.md, CLAUDE.md, agents.md, or claude.md found in the current directory",
		);
	}
}

function issueSummary(failed: number, notFound: number, lowQuality: number) {
	const parts: string[] = [];
	if (failed) parts.push(`${failed} failed`);
	if (notFound) parts.push(`${notFound} stale/not-found`);
	if (lowQuality) parts.push(`${lowQuality} low-quality`);
	return `docsnap: ${parts.join(", ")}`;
}

function failureSummary(summary: RunSummary) {
	return Object.entries(summary.byFailureKind)
		.map(([kind, count]) => `${kind}=${count}`)
		.join(" ");
}
