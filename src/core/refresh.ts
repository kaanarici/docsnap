import { type PriorState, readPriorOutput } from "../output/prior.ts";
import { identityKeys } from "./identity.ts";
import type {
	PageOutput,
	PipelineConfig,
	RefreshChangedPage,
	RefreshSummary,
} from "./types.ts";

export async function refreshSummary(
	prior: PriorState,
	outputs: PageOutput[],
	config: PipelineConfig,
): Promise<RefreshSummary> {
	if (!prior.enabled) return emptyRefreshSummary(prior.reason);

	const changedPages: RefreshChangedPage[] = [];
	const currentKeys = new Set<string>();
	let fresh = 0;
	let changed = 0;
	let unchanged = 0;

	for (const record of outputs) {
		const previous = prior.find(record);
		const previousOutput =
			previous?.outputPath === record.outputPath
				? await readPriorOutput(config, previous.outputPath)
				: undefined;
		const change = !previous
			? "new"
			: previousOutput === record.rendered
				? "unchanged"
				: "changed";
		if (change === "new") fresh++;
		else if (change === "changed") changed++;
		else unchanged++;
		if (change !== "unchanged") {
			const entry: RefreshChangedPage = {
				change,
				url: record.url,
				finalUrl: record.finalUrl,
				outputPath: record.outputPath,
			};
			if (previous?.outputPath && previous.outputPath !== record.outputPath) {
				entry.previousOutputPath = previous.outputPath;
			}
			changedPages.push(entry);
		}
		for (const key of identityKeys(record)) currentKeys.add(key);
	}

	let removed = 0;
	for (const record of prior.records) {
		if (identityKeys(record).some((key) => currentKeys.has(key))) continue;
		removed++;
		changedPages.push({
			change: "removed",
			url: record.url,
			finalUrl: record.finalUrl,
			outputPath: record.outputPath,
			previousOutputPath: record.outputPath,
		});
	}

	const summary: RefreshSummary = {
		enabled: prior.enabled,
		new: fresh,
		changed,
		unchanged,
		removed,
		changedPages,
	};
	if (prior.reason) summary.reason = prior.reason;
	return summary;
}

export function emptyRefreshSummary(
	reason: RefreshSummary["reason"] = "missing_manifest",
): RefreshSummary {
	return {
		enabled: false,
		reason,
		new: 0,
		changed: 0,
		unchanged: 0,
		removed: 0,
		changedPages: [],
	};
}
