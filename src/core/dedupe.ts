import { maxGeneratedCapturePages, maxGeneratedMediaUrls } from "./config.ts";
import { identityKeys, identityUrls } from "./identity.ts";
import { wordCount } from "./text.ts";
import {
	discoverySourceScore,
	type PageRecord,
	type PageSuccess,
} from "./types.ts";

type DedupeResult = {
	records: PageRecord[];
	deduped: number;
};

export function dedupeRecords(records: PageRecord[]): DedupeResult {
	const out: PageRecord[] = [];
	const byKey = new Map<string, PageSuccess>();
	let deduped = 0;

	for (const record of records) {
		if (!record.ok) {
			out.push(record);
			continue;
		}

		const keys = identityKeys(record);
		let target: PageSuccess | undefined;
		for (const key of keys) {
			target = byKey.get(key);
			if (target) break;
		}

		if (target) {
			const survivor = betterRecord(target, record);
			const duplicate = survivor === target ? record : target;
			mergeRecord(survivor, duplicate);
			if (survivor !== target) out[out.indexOf(target)] = survivor;
			for (const key of identityKeys(survivor)) byKey.set(key, survivor);
			deduped++;
			continue;
		}

		out.push(record);
		for (const key of keys) byKey.set(key, record);
	}

	const retained = out.filter((record) => {
		if (record.ok || record.failureKind !== "empty") return true;
		return !identityKeys(record).some((key) => byKey.has(key));
	});
	return { records: retained, deduped: deduped + out.length - retained.length };
}

function mergeRecord(target: PageSuccess, duplicate: PageSuccess) {
	const aliases = new Set(target.aliases ?? []);
	const primary = new Set(identityUrls(target));
	for (const value of identityUrls(duplicate)) {
		if (value && !primary.has(value)) aliases.add(value);
	}
	if (aliases.size) target.aliases = [...aliases].sort();
	else delete target.aliases;
	target.links = [...new Set([...target.links, ...duplicate.links])]
		.slice(0, maxGeneratedCapturePages)
		.sort();
	const media = [
		...new Set([...(target.media ?? []), ...(duplicate.media ?? [])]),
	].slice(0, maxGeneratedMediaUrls);
	if (media.length) target.media = media.sort();
	target.injectionSignals = [
		...new Set([...target.injectionSignals, ...duplicate.injectionSignals]),
	];
	if (!target.publishedAt && duplicate.publishedAt)
		target.publishedAt = duplicate.publishedAt;
	if (!target.updatedAt && duplicate.updatedAt)
		target.updatedAt = duplicate.updatedAt;
}

function betterRecord(a: PageSuccess, b: PageSuccess) {
	if (a.wasSeed !== b.wasSeed) return a.wasSeed ? a : b;
	return recordScore(b) > recordScore(a) ? b : a;
}

function recordScore(record: PageSuccess) {
	return (
		extractorScore(record.extractor) * 10_000 +
		discoverySourceScore(record.source) * 1_000 +
		(record.wasSeed ? 500 : 0) +
		record.confidence * 100 +
		Math.min(wordCount(record.markdown), 2_000) / 100
	);
}

function extractorScore(extractor: PageSuccess["extractor"]): number {
	switch (extractor) {
		case "markdown":
			return 4;
		case "text":
			return 3;
		case "html":
		case "structured":
		case "inline-state":
			return 2;
		case "fallback":
			return 1;
	}
}
