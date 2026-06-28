export type MarkdownLink = {
	text: string;
	href: string;
	suffix: string;
	start: number;
	end: number;
	full: string;
};

export function markdownLinkHrefs(markdown: string): string[] {
	return markdownLinkSpans(markdown).map((link) => link.href);
}

export function markdownLinkCount(markdown: string): number {
	return markdownLinkSpans(markdown).length;
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

function markdownLinkSpans(markdown: string): MarkdownLink[] {
	const links: MarkdownLink[] = [];
	const code = codeRegions(markdown);
	let index = 0;
	while (index < markdown.length) {
		const start = findUnescaped(markdown, "[", index);
		if (start === -1) break;
		const region = code.find((r) => start >= r.start && start < r.end);
		if (region) {
			index = region.end;
			continue;
		}
		const textEnd = findUnescaped(markdown, "]", start + 1);
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

function findUnescaped(markdown: string, target: "[" | "]", start: number) {
	let backslashes = 0;
	for (let index = start; index < markdown.length; index++) {
		const char = markdown[index]!;
		if (char === "\\") {
			backslashes++;
			continue;
		}
		const escaped = backslashes % 2 === 1;
		backslashes = 0;
		if (char === target && !escaped) return index;
	}
	return -1;
}

function invalidHrefChar(char: string) {
	return char === ")" || /\s/.test(char);
}

type CodeRegion = { start: number; end: number };

// Captured docs frequently contain Markdown examples; links inside fenced
// blocks or inline code are source content and must not be rewritten. Linear
// scan: fenced blocks (lines opened by ``` / ~~~) take priority, then inline
// code spans delimited by matching backtick runs on the same logical text.
function codeRegions(markdown: string): CodeRegion[] {
	const regions: CodeRegion[] = [];
	const length = markdown.length;
	let index = 0;
	let lineStart = 0;
	while (index < length) {
		const char = markdown[index]!;
		if (index === lineStart && (char === "`" || char === "~")) {
			const fence = fenceAt(markdown, index, char);
			if (fence) {
				const end = fenceClose(markdown, fence.bodyStart, char, fence.length);
				regions.push({ start: index, end });
				index = end;
				lineStart = end;
				continue;
			}
		}
		if (char === "`") {
			const span = inlineCodeSpan(markdown, index);
			if (span) {
				regions.push({ start: index, end: span });
				index = span;
				continue;
			}
		}
		if (char === "\n") lineStart = index + 1;
		index++;
	}
	return regions;
}

function fenceAt(markdown: string, start: number, marker: "`" | "~") {
	let length = 0;
	while (markdown[start + length] === marker) length++;
	if (length < 3) return undefined;
	let bodyStart = start + length;
	while (bodyStart < markdown.length && markdown[bodyStart] !== "\n")
		bodyStart++;
	return { length, bodyStart: bodyStart + 1 };
}

function fenceClose(
	markdown: string,
	from: number,
	marker: "`" | "~",
	openLength: number,
) {
	let lineStart = from;
	while (lineStart < markdown.length) {
		let cursor = lineStart;
		let run = 0;
		while (markdown[cursor] === marker) {
			run++;
			cursor++;
		}
		if (run >= openLength) {
			const lineEnd = markdown.indexOf("\n", cursor);
			return lineEnd === -1 ? markdown.length : lineEnd + 1;
		}
		const next = markdown.indexOf("\n", lineStart);
		if (next === -1) return markdown.length;
		lineStart = next + 1;
	}
	return markdown.length;
}

function inlineCodeSpan(markdown: string, start: number) {
	let openLength = 0;
	while (markdown[start + openLength] === "`") openLength++;
	let cursor = start + openLength;
	while (cursor < markdown.length) {
		if (markdown[cursor] === "\n") return undefined;
		if (markdown[cursor] === "`") {
			let run = 0;
			while (markdown[cursor + run] === "`") run++;
			if (run === openLength) return cursor + run;
			cursor += run;
			continue;
		}
		cursor++;
	}
	return undefined;
}
