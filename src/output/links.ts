import { replaceMarkdownLinks } from "../core/markdown.ts";
import type { PageSuccess } from "../core/types.ts";
import { urlWithoutFragmentAndQuery } from "../core/url.ts";
import { relativeMarkdownLink } from "./paths.ts";

export function rewriteLocalLinks(
	record: PageSuccess,
	map: Map<string, string>,
): string {
	const fromPath = record.outputPath;
	if (!fromPath) return record.markdown;
	return replaceMarkdownLinks(record.markdown, ({ text, href, suffix }) => {
		try {
			const resolved = new URL(href, record.finalUrl);
			const path = map.get(urlWithoutFragmentAndQuery(href, record.finalUrl));
			if (!path) return undefined;
			const local = relativeMarkdownLink(fromPath, path);
			return `[${text}](${local}${resolved.hash}${suffix})`;
		} catch {
			return undefined;
		}
	});
}
