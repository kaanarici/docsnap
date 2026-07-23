export type Snippet = { lineStart: number; lineEnd: number; text: string };

type SnippetDoc = {
	body: string;
	bodyLineOffset: number;
	frontmatter: string;
	frontmatterTerms: Set<string>;
};

const maxSnippetHits = 2_000;
const clipMarker = "...";

export function docSnippet(
	doc: SnippetDoc,
	queryTerms: Set<string>,
	snippetChars: number,
	literalTerms: string[] = [],
): Snippet {
	const body = bestSnippet(doc.body, queryTerms, snippetChars, literalTerms);
	if (
		queryHits(body.text, queryTerms).length ||
		!frontmatterHit(doc, queryTerms)
	) {
		return {
			...body,
			lineStart: body.lineStart + doc.bodyLineOffset,
			lineEnd: body.lineEnd + doc.bodyLineOffset,
		};
	}
	const meta = bestSnippet(doc.frontmatter, queryTerms, snippetChars);
	return { ...meta, lineStart: meta.lineStart + 1, lineEnd: meta.lineEnd + 1 };
}

function frontmatterHit(doc: SnippetDoc, queryTerms: Set<string>) {
	for (const term of queryTerms)
		if (doc.frontmatterTerms.has(term)) return true;
	return false;
}

function bestSnippet(
	body: string,
	queryTerms: Set<string>,
	snippetChars: number,
	literalTerms: string[] = [],
): Snippet {
	const hit =
		literalHit(body, literalTerms) ??
		densestHit(body, queryTerms, snippetChars);
	const center = hit >= 0 ? hit : 0;
	const half = Math.floor(snippetChars / 2);
	let start = Math.max(0, center - half);
	let end = Math.min(body.length, start + snippetChars);
	start = expandToLineStart(body, start);
	end = expandToLineEnd(body, end);
	if (end - start > snippetChars) {
		const hitLineStart = expandToLineStart(body, center);
		start =
			center - hitLineStart <= half ? hitLineStart : Math.max(0, center - half);
		end = Math.min(body.length, start + snippetChars);
	}
	const clip = readableClip(body, start, end, snippetChars);
	return {
		lineStart: lineNumberAt(body, clip.start),
		lineEnd: lineNumberAt(body, clip.end),
		text: clip.text,
	};
}

function readableClip(
	body: string,
	start: number,
	end: number,
	snippetChars: number,
): { start: number; end: number; text: string } {
	const clippedStart = start > 0 && start !== expandToLineStart(body, start);
	const clippedEnd = end < body.length && end !== expandToLineEnd(body, end);
	let from = clippedStart ? nextBoundary(body, start, end) : start;
	let to = clippedEnd ? previousBoundary(body, from, end) : end;
	const prefix = clippedStart ? `${clipMarker} ` : "";
	const suffix = clippedEnd ? ` ${clipMarker}` : "";
	const maxBodyChars = Math.max(
		0,
		snippetChars - prefix.length - suffix.length,
	);
	if (to <= from) {
		from = start;
		to = end;
	}
	while (from < to && /\s/.test(body[from] ?? "")) from++;
	while (to > from && /\s/.test(body[to - 1] ?? "")) to--;
	if (to - from > maxBodyChars) {
		const boundedEnd = Math.min(to, from + maxBodyChars);
		to = previousBoundary(body, from, boundedEnd);
		if (to <= from) to = boundedEnd;
		while (to > from && /\s/.test(body[to - 1] ?? "")) to--;
	}
	return {
		start: from,
		end: to,
		text: `${prefix}${body.slice(from, to)}${suffix}`,
	};
}

function nextBoundary(body: string, start: number, end: number): number {
	let fallback = start;
	for (let index = start; index < end; index++) {
		if (!isBoundary(body, index)) continue;
		if (fallback === start) fallback = index;
		if (wordChar(body[index] ?? "")) return index;
	}
	return fallback;
}

function previousBoundary(body: string, start: number, end: number): number {
	for (let index = end; index > start; index--) {
		if (isBoundary(body, index)) return index;
	}
	return end;
}

function isBoundary(body: string, index: number) {
	return !wordChar(body[index - 1] ?? "") || !wordChar(body[index] ?? "");
}

function wordChar(char: string) {
	const code = char.charCodeAt(0);
	return (
		(code >= 48 && code <= 57) ||
		(code >= 65 && code <= 90) ||
		(code >= 97 && code <= 122) ||
		code === 95 ||
		code > 127
	);
}

function literalHit(body: string, terms: string[]): number | undefined {
	let best: { rank: number; offset: number } | undefined;
	const haystack = body.toLowerCase();
	for (const term of terms) {
		let offset = -1;
		for (;;) {
			offset = haystack.indexOf(term, offset + 1);
			if (offset < 0) break;
			if (tocLineAt(body, offset)) continue;
			const rank = literalLineRank(body, offset);
			if (
				!best ||
				rank < best.rank ||
				(rank === best.rank && offset < best.offset)
			) {
				best = { rank, offset };
			}
		}
	}
	return best?.offset;
}

function literalLineRank(body: string, index: number) {
	const line = body.slice(
		expandToLineStart(body, index),
		expandToLineEnd(body, index),
	);
	const trimmed = line.trimStart();
	if (/^(?:#{1,6}\s|\*{2,3}|`)/.test(trimmed)) return 0;
	return line.startsWith("    ") || line.startsWith("\t") ? 2 : 1;
}

function densestHit(
	body: string,
	queryTerms: Set<string>,
	snippetChars: number,
): number {
	const hits = queryHits(body, queryTerms);
	if (hits.length === 0) return -1;
	const counts = new Map<string, number>();
	let left = 0;
	let distinct = 0;
	let bestLeft = 0;
	let bestRight = 0;
	let bestDistinct = 0;
	let bestTotal = 0;
	for (let right = 0; right < hits.length; right++) {
		const term = hits[right]!.term;
		const count = counts.get(term) ?? 0;
		if (count === 0) distinct++;
		counts.set(term, count + 1);
		while (
			left < right &&
			hits[right]!.offset - hits[left]!.offset > snippetChars
		) {
			distinct -= removeHit(counts, hits[left++]!.term);
		}
		while (left < right && (counts.get(hits[left]!.term) ?? 0) > 1) {
			removeHit(counts, hits[left++]!.term);
		}
		const total = right - left + 1;
		const span = hits[right]!.offset - hits[left]!.offset;
		const bestSpan = hits[bestRight]!.offset - hits[bestLeft]!.offset;
		if (
			distinct > bestDistinct ||
			(distinct === bestDistinct &&
				(span < bestSpan ||
					(span === bestSpan &&
						(total > bestTotal ||
							(total === bestTotal &&
								hits[left]!.offset < hits[bestLeft]!.offset)))))
		) {
			bestLeft = left;
			bestRight = right;
			bestDistinct = distinct;
			bestTotal = total;
		}
	}
	return Math.floor((hits[bestLeft]!.offset + hits[bestRight]!.offset) / 2);
}

function removeHit(counts: Map<string, number>, term: string) {
	const next = (counts.get(term) ?? 1) - 1;
	if (next > 0) {
		counts.set(term, next);
		return 0;
	}
	counts.delete(term);
	return 1;
}

type TermHit = { term: string; offset: number };

function queryHits(body: string, queryTerms: Set<string>): TermHit[] {
	const hits: TermHit[] = [];
	let current = "";
	let tokenStart = 0;
	const flush = () => {
		if (!current) return;
		const term = current.toLowerCase();
		if (queryTerms.has(term) && !tocLineAt(body, tokenStart)) {
			hits.push({ term, offset: tokenStart });
		}
		current = "";
	};
	for (let i = 0; i < body.length && hits.length < maxSnippetHits; i++) {
		const code = body.charCodeAt(i);
		const isDigit = code >= 48 && code <= 57;
		const isUpper = code >= 65 && code <= 90;
		const isLower = code >= 97 && code <= 122;
		if (isDigit || isLower || code > 127) {
			if (!current) tokenStart = i;
			current += body.charAt(i);
		} else if (isUpper) {
			if (!current) tokenStart = i;
			current += String.fromCharCode(code + 32);
		} else {
			flush();
		}
	}
	flush();
	return hits;
}

function tocLineAt(body: string, index: number): boolean {
	const start = expandToLineStart(body, index);
	const end = expandToLineEnd(body, index);
	const line = body.slice(start, end).trim();
	return /^(?:[-*+]|\d+[.)])\s+\[[^\]]{1,180}\]\((?:#|\.\/[^)\s]*#|[^)\s]+\.md#)[^)]+\)$/i.test(
		line,
	);
}

function expandToLineStart(body: string, index: number): number {
	const nl = body.lastIndexOf("\n", index);
	return nl < 0 ? 0 : nl + 1;
}

function expandToLineEnd(body: string, index: number): number {
	const nl = body.indexOf("\n", index);
	return nl < 0 ? body.length : nl;
}

export function lineNumberAt(text: string, index: number): number {
	let line = 1;
	for (let i = 0; i < index && i < text.length; i++) {
		if (text[i] === "\n") line++;
	}
	return line;
}
