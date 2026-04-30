export type MarkdownLink = {
	text: string;
	href: string;
	suffix: string;
};

function markdownLinks(markdown: string): MarkdownLink[] {
	return [...markdown.matchAll(linkPattern())].map((match) => ({
		text: match[1]!,
		href: match[2]!,
		suffix: match[3]!,
	}));
}

export function markdownLinkHrefs(markdown: string): string[] {
	return markdownLinks(markdown).map((link) => link.href);
}

export function markdownLinkCount(markdown: string): number {
	return markdownLinks(markdown).length;
}

export function replaceMarkdownLinks(
	markdown: string,
	replace: (link: MarkdownLink) => string | undefined,
): string {
	return markdown.replace(linkPattern(), (full, text, href, suffix) => {
		return replace({ text, href, suffix }) ?? full;
	});
}

function linkPattern() {
	return /\[([^\]]*)]\(([^)\s]+)([^)]*)\)/g;
}
