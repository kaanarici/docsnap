import { identityKeys } from "./identity.ts";
import { wordCount } from "./text.ts";
import type { PageRecord, PageSuccess } from "./types.ts";

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
		const target = keys
			.map((key) => byKey.get(key))
			.find((item): item is PageSuccess => Boolean(item));

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

	return { records: out, deduped };
}

function mergeRecord(target: PageSuccess, duplicate: PageSuccess) {
	const aliases = new Set(target.aliases ?? []);
	const primary = new Set(
		[target.url, target.finalUrl, target.canonicalUrl].filter(
			(value): value is string => Boolean(value),
		),
	);
	for (const value of [
		duplicate.url,
		duplicate.finalUrl,
		duplicate.canonicalUrl,
	]) {
		if (value && !primary.has(value)) aliases.add(value);
	}
	if (aliases.size) target.aliases = [...aliases].sort();
	else delete target.aliases;
	target.links = [...new Set([...target.links, ...duplicate.links])].sort();
	target.injectionSignals = [
		...new Set([...target.injectionSignals, ...duplicate.injectionSignals]),
	];
	if (!target.publishedAt && duplicate.publishedAt)
		target.publishedAt = duplicate.publishedAt;
	if (!target.updatedAt && duplicate.updatedAt)
		target.updatedAt = duplicate.updatedAt;
}

function betterRecord(a: PageSuccess, b: PageSuccess) {
	return recordScore(b) > recordScore(a) ? b : a;
}

function recordScore(record: PageSuccess) {
	return (
		sourceScore[record.source] * 10_000 +
		extractorScore[record.extractor] * 1_000 +
		record.confidence * 100 +
		Math.min(wordCount(record.markdown), 2_000) / 100
	);
}

const sourceScore: Record<PageSuccess["source"], number> = {
	llms: 7,
	asset: 6,
	render: 6,
	sitemap: 5,
	feed: 4,
	nav: 3,
	crawl: 2,
	seed: 1,
};

const extractorScore: Record<PageSuccess["extractor"], number> = {
	markdown: 4,
	text: 3,
	html: 2,
	"inline-state": 2,
	fallback: 1,
};
