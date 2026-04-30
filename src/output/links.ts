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
			const path = map.get(urlWithoutFragmentAndQuery(href, record.finalUrl));
			return path
				? `[${text}](${relativeMarkdownLink(fromPath, path)}${suffix})`
				: undefined;
		} catch {
			return undefined;
		}
	});
}
