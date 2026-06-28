import { posix } from "node:path";
import { replaceMarkdownLinks } from "../core/markdown.ts";
import { hashContent } from "../core/snapshot.ts";
import type { PathedPage } from "../core/types.ts";
import { urlWithoutFragment } from "../core/url.ts";
import { relativeMarkdownLink } from "./paths.ts";

export function rewriteLocalLinks(
	record: PathedPage,
	map: Map<string, string>,
): PathedPage {
	const markdown = rewriteMarkdown(record, map, new Set(map.values())).trim();
	return { ...record, markdown, contentHash: hashContent(markdown) };
}

function rewriteMarkdown(
	record: PathedPage,
	map: Map<string, string>,
	outputPaths: Set<string>,
): string {
	const fromPath = record.outputPath;
	return replaceMarkdownLinks(record.markdown, (link) => {
		const { text, href, suffix } = link;
		try {
			if (isLocalOutputHref(href, fromPath, outputPaths)) {
				return isHeadingLeadLink(record.markdown, link.start)
					? text
					: undefined;
			}
			const resolved = new URL(href, record.finalUrl);
			const path = map.get(urlWithoutFragment(href, record.finalUrl));
			if (!path) {
				// Uncaptured relative links must remain followable from the local file.
				const http =
					resolved.protocol === "http:" || resolved.protocol === "https:";
				return isRelativeHref(href) && http
					? `[${text}](${resolved.href}${suffix})`
					: undefined;
			}
			if (isHeadingLeadLink(record.markdown, link.start)) return text;
			const local = relativeMarkdownLink(fromPath, path);
			return `[${text}](${local}${resolved.hash}${suffix})`;
		} catch {
			return undefined;
		}
	});
}

function isHeadingLeadLink(markdown: string, linkStart: number): boolean {
	const lineStart = markdown.lastIndexOf("\n", linkStart - 1) + 1;
	const prefix = markdown.slice(lineStart, linkStart);
	return /^\s{0,3}#{1,6}\s+$/.test(prefix);
}

function isLocalOutputHref(
	href: string,
	fromPath: string,
	outputPaths: Set<string>,
): boolean {
	if (!isRelativeHref(href)) return false;
	const path = href.split(/[?#]/, 1)[0];
	if (!path || path.startsWith("#")) return false;
	const dir = fromPath.includes("/")
		? fromPath.slice(0, fromPath.lastIndexOf("/") + 1)
		: "";
	const normalized = posix.normalize(posix.join(dir, path));
	return !normalized.startsWith("../") && outputPaths.has(normalized);
}

function isRelativeHref(href: string): boolean {
	try {
		new URL(href);
		return false;
	} catch {
		return true;
	}
}
