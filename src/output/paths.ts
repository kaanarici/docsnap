import { createHash } from "node:crypto";
import { relative } from "node:path";
import { safeDecode } from "../core/text.ts";
import type { PageSuccess, PathedPage } from "../core/types.ts";
import { urlWithoutFragmentAndQuery } from "../core/url.ts";

// Pure stage transition: each input success becomes a new PathedPage carrying its
// assigned outputPath. The source records are never mutated, so a reference held
// before this call still sees a PageSuccess without an outputPath.
export function assignOutputPaths(records: PageSuccess[]): PathedPage[] {
	const prefix = pathPrefix(records);
	const byBase = new Map<string, PageSuccess[]>();
	for (const record of records) {
		const base = basePath(record.finalUrl, prefix);
		const group = byBase.get(base) ?? [];
		group.push(record);
		byBase.set(base, group);
	}

	const paths = new Map<PageSuccess, string>();
	for (const [base, group] of byBase) {
		const sorted = [...group].sort((a, b) =>
			`${a.finalUrl}\0${a.url}`.localeCompare(`${b.finalUrl}\0${b.url}`),
		);
		for (const record of sorted) {
			paths.set(
				record,
				group.length === 1 ? base : withSuffix(base, shortHash(record.url)),
			);
		}
	}
	return records.map((record) => ({
		...record,
		outputPath: paths.get(record)!,
	}));
}

export function pathMap(records: PathedPage[]): Map<string, string> {
	const map = new Map<string, string>();
	for (const record of records) {
		for (const url of urlAliases(record)) {
			map.set(urlWithoutFragmentAndQuery(url), record.outputPath);
		}
	}
	return map;
}

function urlAliases(record: PageSuccess) {
	return [
		record.url,
		record.finalUrl,
		record.canonicalUrl,
		...(record.aliases ?? []),
	].filter((value): value is string => Boolean(value));
}

export function relativeMarkdownLink(fromPath: string, toPath: string): string {
	let link = relative(fromPath.replace(/[^/]+$/, ""), toPath).replaceAll(
		"\\",
		"/",
	);
	if (!link.startsWith(".")) link = `./${link}`;
	return link;
}

function basePath(raw: string, prefix: string[]) {
	const parts = stripPrefix(outputSegments(raw), prefix);
	return `${parts.join("/") || "index"}.md`;
}

function pathPrefix(records: PageSuccess[]) {
	return commonPrefix(records.map((record) => outputSegments(record.finalUrl)));
}

function outputSegments(raw: string) {
	const url = new URL(raw);
	const parts = url.pathname.split("/").filter(Boolean).map(slug);
	if (url.pathname.endsWith("/") || parts.length === 0) parts.push("index");
	return parts;
}

function commonPrefix(paths: string[][]) {
	if (paths.length < 2) return [];
	const prefix = [...paths[0]!];
	for (const path of paths.slice(1)) {
		while (prefix.length && !startsWith(path, prefix)) prefix.pop();
	}
	return prefix;
}

function stripPrefix(path: string[], prefix: string[]) {
	return startsWith(path, prefix) ? path.slice(prefix.length) : path;
}

function startsWith(path: string[], prefix: string[]) {
	return prefix.every((part, index) => path[index] === part);
}

function withSuffix(path: string, suffix: string) {
	return path.replace(/\.md$/, `-${suffix}.md`);
}

// keep each path segment well under the common 255-byte filesystem component
// limit; long segments are truncated with a stable hash suffix so distinct
// long URLs still map to distinct, writable filenames
const maxSlugChars = 120;

function slug(value: string) {
	const clean = safeDecode(value)
		.toLowerCase()
		.replace(/\.(html?|mdx?|ya?ml|json|txt)$/i, "")
		.replace(/[^a-z0-9._-]+/g, "-")
		.replace(/^-+|-+$/g, "");
	if (/^\.+$/.test(clean)) return "page";
	const safe = clean || "page";
	if (safe.length <= maxSlugChars) return safe;
	const head = safe.slice(0, maxSlugChars - 9).replace(/-+$/, "");
	return `${head}-${shortHash(value)}`;
}

function shortHash(value: string) {
	return createHash("sha256").update(value).digest("hex").slice(0, 8);
}
