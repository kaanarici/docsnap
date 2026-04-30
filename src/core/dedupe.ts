import { wordCount } from "./text.ts";
import type { PageRecord, PageSuccess } from "./types.ts";
import { dropFragmentAndQuery } from "./url.ts";

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
}

function identityKeys(record: PageSuccess) {
	return [record.finalUrl, record.url, ...(record.aliases ?? [])]
		.flatMap((url) => [urlKey(url), routeKey(url)])
		.filter((value): value is string => Boolean(value));
}

function urlKey(raw: string | undefined) {
	if (!raw) return undefined;
	const url = dropFragmentAndQuery(new URL(raw));
	if (url.pathname !== "/") url.pathname = url.pathname.replace(/\/+$/, "");
	return `url:${url.href}`;
}

function routeKey(raw: string | undefined) {
	if (!raw) return undefined;
	const url = dropFragmentAndQuery(new URL(raw));
	let path = safeDecode(url.pathname).replace(/\/+$/, "");
	path = path.replace(/\/index(?:\.(?:html?|mdx?|txt))?$/i, "");
	path = path.replace(/\.(?:html?|mdx?|txt)$/i, "");
	return `route:${url.origin}${path || "/"}`;
}

function safeDecode(value: string) {
	try {
		return decodeURIComponent(value);
	} catch {
		return value;
	}
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
	llms: 6,
	asset: 5,
	sitemap: 4,
	nav: 3,
	crawl: 2,
	seed: 1,
};

const extractorScore: Record<PageSuccess["extractor"], number> = {
	markdown: 4,
	text: 3,
	html: 2,
	fallback: 1,
};
