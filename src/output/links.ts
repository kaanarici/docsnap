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
			if (!path) {
				// a relative internal link to an uncaptured page dangles from a local
				// .md file; absolutize it against the page URL so an agent can still
				// follow it. already-absolute links (external, mailto, …) are left as-is.
				const http =
					resolved.protocol === "http:" || resolved.protocol === "https:";
				return isRelativeHref(href) && http
					? `[${text}](${resolved.href}${suffix})`
					: undefined;
			}
			const local = relativeMarkdownLink(fromPath, path);
			return `[${text}](${local}${resolved.hash}${suffix})`;
		} catch {
			return undefined;
		}
	});
}

function isRelativeHref(href: string): boolean {
	try {
		new URL(href);
		return false;
	} catch {
		return true;
	}
}
