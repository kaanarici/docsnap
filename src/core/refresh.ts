import { renderPage } from "../output/page.ts";
import {
	type PriorPage,
	type PriorState,
	readPriorOutput,
} from "../output/prior.ts";
import { identityKeys } from "./identity.ts";
import { hasOutputPath } from "./records.ts";
import type {
	Config,
	DiscoveredUrl,
	PageRecord,
	PageSuccess,
	RefreshChangedPage,
	RefreshSummary,
} from "./types.ts";

export type RefreshCounters = {
	notModified: number;
	reused: number;
	fallbackRefetches: number;
	skippedWrites: number;
};

export function refreshCounters(): RefreshCounters {
	return {
		notModified: 0,
		reused: 0,
		fallbackRefetches: 0,
		skippedWrites: 0,
	};
}

export async function refreshSummary(
	prior: PriorState,
	records: PageRecord[],
	attempted: DiscoveredUrl[],
	config: Config,
	counters: RefreshCounters,
): Promise<RefreshSummary> {
	const changedPages: RefreshChangedPage[] = [];
	let checked = 0;
	let fresh = 0;
	let changed = 0;
	let unchanged = 0;

	for (const record of records.filter(hasOutputPath)) {
		const previous = prior.find(record);
		const change = previous
			? (await existingOutputMatches(config, previous, record))
				? "unchanged"
				: "changed"
			: "new";
		if (previous) checked++;
		if (change === "new") fresh++;
		else if (change === "changed") changed++;
		else unchanged++;
		changedPages.push(changeEntry(change, record, previous));
	}

	const currentKeys = new Set<string>();
	for (const item of attempted) addKeys(currentKeys, item);
	for (const record of records) addKeys(currentKeys, record);
	const removed = prior.records.filter(
		(record) => !identityKeys(record).some((key) => currentKeys.has(key)),
	);
	for (const record of removed) {
		changedPages.push({
			change: "removed",
			url: record.url,
			finalUrl: record.finalUrl,
			outputPath: record.outputPath,
			previousOutputPath: record.outputPath,
		});
	}

	return {
		enabled: prior.enabled,
		...(prior.reason ? { reason: prior.reason } : {}),
		priorRecords: prior.records.length,
		checked,
		notModified: counters.notModified,
		reused: counters.reused,
		fallbackRefetches: counters.fallbackRefetches,
		skippedWrites: counters.skippedWrites,
		new: fresh,
		changed,
		unchanged,
		removed: removed.length,
		changedPages,
	};
}

export function emptyRefreshSummary(
	reason: RefreshSummary["reason"] = "missing_manifest",
): RefreshSummary {
	return {
		enabled: false,
		reason,
		priorRecords: 0,
		checked: 0,
		notModified: 0,
		reused: 0,
		fallbackRefetches: 0,
		skippedWrites: 0,
		new: 0,
		changed: 0,
		unchanged: 0,
		removed: 0,
		changedPages: [],
	};
}

async function existingOutputMatches(
	config: Config,
	previous: PriorPage,
	current: PageSuccess & { outputPath: string },
) {
	if (previous.outputPath !== current.outputPath) return false;
	try {
		return (
			(await readPriorOutput(config, previous.outputPath)) ===
			renderPage(current)
		);
	} catch {
		return false;
	}
}

function changeEntry(
	change: "new" | "changed" | "unchanged",
	record: PageSuccess & { outputPath: string },
	previous: PriorPage | undefined,
): RefreshChangedPage {
	return {
		change,
		url: record.url,
		finalUrl: record.finalUrl,
		outputPath: record.outputPath,
		...(previous?.outputPath && previous.outputPath !== record.outputPath
			? { previousOutputPath: previous.outputPath }
			: {}),
	};
}

function addKeys(
	target: Set<string>,
	input: Parameters<typeof identityKeys>[0],
) {
	for (const key of identityKeys(input)) target.add(key);
}
