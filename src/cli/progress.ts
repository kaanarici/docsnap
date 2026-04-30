import type { RunSummary } from "../core/types.ts";
import { runFiles } from "../output/files.ts";

export function note(message: string): void {
	process.stderr.write(`${message}\n`);
}

export function printSummary(summary: RunSummary): void {
	const seconds = (summary.elapsedMs / 1000).toFixed(2);
	note(
		`docsnap: ${summary.written} pages ${summary.dryRun ? "found" : `written to ${summary.outDir}`} in ${seconds}s`,
	);
	if (summary.maxAppliesTo === "non-llms" && summary.written > summary.max) {
		note(`docsnap: llms.txt corpus included ${summary.written} pages`);
	}
	if (summary.maxReached) {
		note(
			`docsnap: page limit reached; rerun with -m ${summary.max * 2} for more`,
		);
	}
	if (summary.failed || summary.lowQuality) {
		note(
			`docsnap: ${summary.failed} failed, ${summary.lowQuality} low-quality`,
		);
		const failures = failureSummary(summary);
		if (failures) note(`docsnap: failure kinds ${failures}`);
	}
	if (!summary.dryRun) {
		note(`docsnap: summary ${summary.outDir}/${runFiles.summary}`);
		note(`docsnap: manifest ${summary.outDir}/${runFiles.manifest}`);
		note(`docsnap: agent handoff ${summary.outDir}/${runFiles.agentReadme}`);
	}
}

function failureSummary(summary: RunSummary) {
	return Object.entries(summary.byFailureKind)
		.map(([kind, count]) => `${kind}=${count}`)
		.join(" ");
}
