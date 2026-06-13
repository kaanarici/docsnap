export type MarkdownLink = {
	text: string;
	href: string;
	suffix: string;
};

function markdownLinks(markdown: string): MarkdownLink[] {
	return markdownLinkSpans(markdown);
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
	let out = "";
	let cursor = 0;
	for (const link of markdownLinkSpans(markdown)) {
		out += markdown.slice(cursor, link.start);
		out += replace(link) ?? link.full;
		cursor = link.end;
	}
	return cursor === 0 ? markdown : out + markdown.slice(cursor);
}

type MarkdownLinkSpan = MarkdownLink & {
	start: number;
	end: number;
	full: string;
};

function markdownLinkSpans(markdown: string): MarkdownLinkSpan[] {
	const links: MarkdownLinkSpan[] = [];
	let index = 0;
	while (index < markdown.length) {
		const start = markdown.indexOf("[", index);
		if (start === -1) break;
		const textEnd = markdown.indexOf("]", start + 1);
		if (textEnd === -1) break;
		if (markdown[textEnd + 1] !== "(") {
			index = textEnd + 1;
			continue;
		}
		const hrefStart = textEnd + 2;
		if (hrefStart >= markdown.length || invalidHrefChar(markdown[hrefStart]!)) {
			index = hrefStart + 1;
			continue;
		}
		let hrefEnd = hrefStart + 1;
		while (hrefEnd < markdown.length && !invalidHrefChar(markdown[hrefEnd]!)) {
			hrefEnd++;
		}
		const end = markdown.indexOf(")", hrefEnd);
		if (end === -1) break;
		links.push({
			text: markdown.slice(start + 1, textEnd),
			href: markdown.slice(hrefStart, hrefEnd),
			suffix: markdown.slice(hrefEnd, end),
			start,
			end: end + 1,
			full: markdown.slice(start, end + 1),
		});
		index = end + 1;
	}
	return links;
}

function invalidHrefChar(char: string) {
	return char === ")" || /\s/.test(char);
}
