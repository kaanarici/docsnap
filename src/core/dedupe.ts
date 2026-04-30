import type { PageRecord, PageSuccess } from "./types.ts";
import { dropFragmentAndQuery } from "./url.ts";

type DedupeResult = {
	records: PageRecord[];
	deduped: number;
};

export function dedupeRecords(records: PageRecord[]): DedupeResult {
	const out: PageRecord[] = [];
	const byUrl = new Map<string, PageSuccess>();
	let deduped = 0;

	for (const record of records) {
		if (!record.ok) {
			out.push(record);
			continue;
		}

		const keys = urlKeys(record);
		const target = keys
			.map((key) => byUrl.get(key))
			.find((item) => item?.contentHash === record.contentHash);

		if (target) {
			mergeRecord(target, record);
			deduped++;
			continue;
		}

		out.push(record);
		for (const key of keys) byUrl.set(key, record);
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
}

function urlKeys(record: PageSuccess) {
	return [
		record.canonicalUrl,
		record.finalUrl,
		record.url,
		...(record.aliases ?? []),
	]
		.map(urlKey)
		.filter((value): value is string => Boolean(value));
}

function urlKey(raw: string | undefined) {
	if (!raw) return undefined;
	const url = dropFragmentAndQuery(new URL(raw));
	if (url.pathname !== "/") url.pathname = url.pathname.replace(/\/+$/, "");
	return url.href;
}
