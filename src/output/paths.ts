import { createHash } from "node:crypto";
import { relative } from "node:path";
import { hasOutputPath, isPageSuccess } from "../core/records.ts";
import type { PageRecord, PageSuccess } from "../core/types.ts";
import { urlWithoutFragmentAndQuery } from "../core/url.ts";

export function assignOutputPaths(records: PageRecord[]): void {
	const ok = records.filter(isPageSuccess);
	const prefix = pathPrefix(ok);
	const byBase = new Map<string, PageSuccess[]>();
	for (const record of ok) {
		const base = basePath(record.finalUrl, prefix);
		const group = byBase.get(base) ?? [];
		group.push(record);
		byBase.set(base, group);
	}

	for (const [base, group] of byBase) {
		const sorted = [...group].sort((a, b) =>
			`${a.finalUrl}\0${a.url}`.localeCompare(`${b.finalUrl}\0${b.url}`),
		);
		for (const record of sorted) {
			record.outputPath =
				group.length === 1 ? base : withSuffix(base, shortHash(record.url));
		}
	}
}

export function pathMap(records: PageRecord[]): Map<string, string> {
	const map = new Map<string, string>();
	for (const record of records.filter(hasOutputPath)) {
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
	const parts = routeSegments(raw);
	if (url.pathname.endsWith("/") || parts.length === 0) parts.push("index");
	return parts;
}

function routeSegments(raw: string) {
	const url = new URL(raw);
	return url.pathname.split("/").filter(Boolean).map(slug);
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

function slug(value: string) {
	const clean = safeDecode(value)
		.toLowerCase()
		.replace(/\.(html?|mdx?|ya?ml|json|txt)$/i, "")
		.replace(/[^a-z0-9._-]+/g, "-")
		.replace(/^-+|-+$/g, "");
	if (/^\.+$/.test(clean)) return "page";
	return clean || "page";
}

function safeDecode(value: string) {
	try {
		return decodeURIComponent(value);
	} catch {
		return value;
	}
}

function shortHash(value: string) {
	return createHash("sha256").update(value).digest("hex").slice(0, 8);
}
