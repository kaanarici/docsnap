import { createHash } from "node:crypto";
import { relative } from "node:path";
import { identityUrls } from "../core/identity.ts";
import { safeDecode } from "../core/text.ts";
import type { PageSuccess, PathedPage } from "../core/types.ts";
import { urlWithoutFragment } from "../core/url.ts";

export function assignOutputPaths(records: PageSuccess[]): PathedPage[] {
	if (records.length === 1) return [{ ...records[0]!, outputPath: "index.md" }];
	const prefix = commonPrefix(
		records.map((record) => outputSegments(record.finalUrl)),
	);
	const byBase = new Map<string, PageSuccess[]>();
	for (const record of records) {
		const parts = stripPrefix(outputSegments(record.finalUrl), prefix);
		const base = `${parts.join("/") || "index"}.md`;
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
				group.length === 1
					? base
					: base.replace(/\.md$/, `-${shortHash(record.url)}.md`),
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
	const ambiguous = new Set<string>();
	for (const record of records) {
		for (const url of identityUrls(record)) {
			addPathKey(map, ambiguous, urlWithoutFragment(url), record.outputPath);
		}
	}
	for (const key of ambiguous) map.delete(key);
	return map;
}

function addPathKey(
	map: Map<string, string>,
	ambiguous: Set<string>,
	key: string,
	outputPath: string,
) {
	if (ambiguous.has(key)) return;
	const current = map.get(key);
	if (!current || current === outputPath) map.set(key, outputPath);
	else {
		map.delete(key);
		ambiguous.add(key);
	}
}

export function relativeMarkdownLink(fromPath: string, toPath: string): string {
	let link = relative(fromPath.replace(/[^/]+$/, ""), toPath).replaceAll(
		"\\",
		"/",
	);
	if (!link.startsWith(".")) link = `./${link}`;
	return link;
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

// Leave room under the common 255-byte filesystem component limit.
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
