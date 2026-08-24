export type MarkdownLink = {
	text: string;
	href: string;
	suffix: string;
	start: number;
	end: number;
	full: string;
};

export function safeMarkdownDestination(value: string) {
	let depth = 0;
	for (const char of value) {
		if (char === "(") depth++;
		else if (char === ")" && depth-- === 0) return encodeParentheses(value);
	}
	return depth === 0 ? value : encodeParentheses(value);
}

export function markdownLinkHrefs(markdown: string, limit?: number): string[] {
	const hrefs: string[] = [];
	if (limit !== undefined && limit <= 0) return hrefs;
	for (const link of markdownLinkSpans(markdown)) {
		if (isImage(markdown, link.start)) continue;
		hrefs.push(link.href);
		if (limit !== undefined && hrefs.length >= limit) break;
	}
	return hrefs;
}

export function markdownImageHrefs(markdown: string, limit?: number): string[] {
	const hrefs: string[] = [];
	if (limit !== undefined && limit <= 0) return hrefs;
	for (const link of markdownLinkSpans(markdown)) {
		if (!isImage(markdown, link.start)) continue;
		hrefs.push(link.href);
		if (limit !== undefined && hrefs.length >= limit) break;
	}
	return hrefs;
}

export function* markdownHrefs(markdown: string): Generator<string> {
	for (const link of markdownLinkSpans(markdown)) yield link.href;
}

export function markdownLinkCount(markdown: string): number {
	let count = 0;
	for (const link of markdownLinkSpans(markdown)) {
		if (!isImage(markdown, link.start)) count++;
	}
	return count;
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

function* markdownLinkSpans(markdown: string): Generator<MarkdownLink> {
	const code = codeRegions(markdown);
	let index = 0;
	let regionIndex = 0;
	while (index < markdown.length) {
		const start = findUnescaped(markdown, "[", index);
		if (start === -1) break;
		while (regionIndex < code.length && code[regionIndex]!.end <= start)
			regionIndex++;
		const region = code[regionIndex];
		if (region) {
			if (start >= region.start) {
				index = region.end;
				continue;
			}
		}
		const textEnd = findUnescaped(markdown, "]", start + 1);
		if (textEnd === -1) break;
		if (markdown[textEnd + 1] !== "(") {
			index = textEnd + 1;
			continue;
		}
		const hrefStart = textEnd + 2;
		if (hrefStart >= markdown.length || /[)\s]/.test(markdown[hrefStart]!)) {
			index = hrefStart + 1;
			continue;
		}
		const destination = markdownDestination(markdown, hrefStart);
		if (!destination) break;
		const { hrefEnd, end } = destination;
		yield {
			text: markdown.slice(start + 1, textEnd),
			href: parsedDestination(markdown.slice(hrefStart, hrefEnd)),
			suffix: markdown.slice(hrefEnd, end),
			start,
			end: end + 1,
			full: markdown.slice(start, end + 1),
		};
		index = end + 1;
	}
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

function markdownDestination(markdown: string, start: number) {
	let depth = 1;
	let hrefEnd: number | undefined;
	let quote = "";
	let backslashes = 0;
	for (let index = start; index < markdown.length; index++) {
		const char = markdown[index]!;
		if (char === "\\") {
			backslashes++;
			continue;
		}
		const escaped = backslashes % 2 === 1;
		backslashes = 0;
		if (escaped) continue;
		if (hrefEnd !== undefined && (char === '"' || char === "'")) {
			quote = quote === char ? "" : quote || char;
			continue;
		}
		if (quote) continue;
		if (/\s/.test(char)) {
			if (hrefEnd === undefined) {
				if (depth !== 1) return undefined;
				hrefEnd = index;
			}
			continue;
		}
		if (char === "(") depth++;
		if (char !== ")" || --depth > 0) continue;
		return { hrefEnd: hrefEnd ?? index, end: index };
	}
	return undefined;
}

function parsedDestination(value: string) {
	let out = "";
	for (let index = 0; index < value.length; index++) {
		let char = value[index]!;
		const next = value[index + 1];
		if (char === "\\" && (next === "(" || next === ")")) {
			char = value[++index]!;
		}
		out += char;
	}
	return safeMarkdownDestination(out);
}

const encodeParentheses = (value: string) =>
	value.replaceAll("(", "%28").replaceAll(")", "%29");

function isImage(markdown: string, start: number) {
	if (markdown[start - 1] !== "!") return false;
	let backslashes = 0;
	for (let index = start - 2; markdown[index] === "\\"; index--) backslashes++;
	return backslashes % 2 === 0;
}

type CodeRegion = { start: number; end: number };

function codeRegions(markdown: string): CodeRegion[] {
	const regions: CodeRegion[] = [];
	const length = markdown.length;
	let index = 0;
	let lineStart = 0;
	while (index < length) {
		const char = markdown[index]!;
		if (index === lineStart) {
			const fence = fenceAt(markdown, index);
			if (fence) {
				const end = fenceClose(
					markdown,
					fence.bodyStart,
					fence.marker,
					fence.length,
				);
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

type FenceOpening = {
	marker: "`" | "~";
	length: number;
	bodyStart: number;
};

function fenceAt(
	markdown: string,
	lineStart: number,
): FenceOpening | undefined {
	let start = lineStart;
	while (start - lineStart < 3 && markdown[start] === " ") start++;
	const marker = markdown[start];
	if (marker !== "`" && marker !== "~") return undefined;
	let length = 0;
	while (markdown[start + length] === marker) length++;
	if (length < 3) return undefined;
	let bodyStart = start + length;
	while (bodyStart < markdown.length && markdown[bodyStart] !== "\n")
		bodyStart++;
	return { marker, length, bodyStart: bodyStart + 1 };
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
		while (cursor - lineStart < 3 && markdown[cursor] === " ") cursor++;
		let run = 0;
		while (markdown[cursor] === marker) {
			run++;
			cursor++;
		}
		if (run >= openLength) {
			const lineEnd = markdown.indexOf("\n", cursor);
			const end = lineEnd === -1 ? markdown.length : lineEnd;
			while (cursor < end && /[ \t\r]/.test(markdown[cursor]!)) cursor++;
			if (cursor === end) return lineEnd === -1 ? end : end + 1;
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
