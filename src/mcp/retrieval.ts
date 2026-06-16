import { hashContent } from "../core/snapshot.ts";
import { McpReadLimitError } from "./access.ts";
import type { CorpusPage } from "./corpus.ts";

// In-house ranked retrieval over a captured corpus. BM25 over body tokens with
// field boosts for matches in titles/headings/path/frontmatter, and a
// confidence/injection penalty so low-quality and injection-signal pages do not
// outrank clean ones. No deps, fully bounded, and free of any RegExp built from
// untrusted page text (tokenization scans char-by-char to stay ReDoS-safe).

export type RankedSnippet = {
	record: CorpusPage & { outputPath: string };
	contentHash: string;
	extractor: string;
	score: number;
	confidence: number;
	lineStart: number;
	lineEnd: number;
	text: string;
};

export type RankInput = {
	pages: PageDoc[];
	totalDocs: number;
	avgBodyLength: number;
	docFreq: Map<string, number>;
};

export type PageDoc = {
	record: CorpusPage & { outputPath: string };
	body: string;
	titleTerms: Set<string>;
	headingTerms: Set<string>;
	pathTerms: Set<string>;
	frontmatterTerms: Set<string>;
	bodyTermFreq: Map<string, number>;
	bodyLength: number;
};

const bm25K1 = 1.2;
const bm25B = 0.75;
const fieldBoost = {
	title: 3.2,
	heading: 1.8,
	path: 1.4,
	frontmatter: 0.9,
};
const maxTermsPerField = 4_000;
const maxQueryTerms = 32;
const minTermLength = 2;
const maxTermLength = 48;

// PageLoader yields the bounded Markdown for one manifest record (or null when
// the page exceeds read caps), keeping retrieval independent of fs access.
export type PageLoader = (
	record: CorpusPage & { outputPath: string },
) => Promise<string | null>;

export async function buildRankInput(
	records: CorpusPage[],
	load: PageLoader,
	limits: { maxPages: number; maxBytes: number },
): Promise<{ input: RankInput; truncated: boolean }> {
	const pages: PageDoc[] = [];
	const docFreq = new Map<string, number>();
	let scannedBytes = 0;
	let totalBodyLength = 0;
	let truncated = false;
	for (const record of records) {
		if (!record.ok || !record.outputPath) continue;
		if (pages.length >= limits.maxPages || scannedBytes >= limits.maxBytes) {
			truncated = true;
			break;
		}
		let source: string | null;
		try {
			source = await load(record as CorpusPage & { outputPath: string });
		} catch (error) {
			if (error instanceof McpReadLimitError) {
				truncated = true;
				continue;
			}
			throw error;
		}
		if (source === null) {
			truncated = true;
			continue;
		}
		scannedBytes += Buffer.byteLength(source);
		const doc = toPageDoc(
			record as CorpusPage & { outputPath: string },
			source,
		);
		for (const term of doc.bodyTermFreq.keys()) {
			docFreq.set(term, (docFreq.get(term) ?? 0) + 1);
		}
		totalBodyLength += doc.bodyLength;
		pages.push(doc);
	}
	return {
		input: {
			pages,
			totalDocs: pages.length,
			avgBodyLength: pages.length ? totalBodyLength / pages.length : 0,
			docFreq,
		},
		truncated,
	};
}

export function rankPages(
	input: RankInput,
	query: string,
	options: {
		maxResults: number;
		snippetChars: number;
		excludeInjection: boolean;
	},
): RankedSnippet[] {
	const queryTerms = tokenize(query).slice(0, maxQueryTerms);
	if (queryTerms.length === 0) return [];
	const queryTermSet = new Set(queryTerms);
	const scored: RankedSnippet[] = [];
	for (const doc of input.pages) {
		const highRisk = doc.record.injectionSignals.length > 0;
		if (options.excludeInjection && highRisk) continue;
		const score = scoreDoc(input, doc, queryTerms);
		if (score <= 0) continue;
		const snippet = bestSnippet(doc.body, queryTermSet, options.snippetChars);
		scored.push({
			record: doc.record,
			contentHash: doc.record.contentHash ?? hashContent(doc.body),
			extractor: doc.record.extractor ?? "unknown",
			score,
			confidence: doc.record.confidence ?? 0,
			lineStart: snippet.lineStart,
			lineEnd: snippet.lineEnd,
			text: snippet.text,
		});
	}
	// deterministic order: score desc, then path asc as a stable tiebreaker
	scored.sort(
		(a, b) =>
			b.score - a.score ||
			a.record.outputPath.localeCompare(b.record.outputPath),
	);
	return scored.slice(0, options.maxResults);
}

function scoreDoc(
	input: RankInput,
	doc: PageDoc,
	queryTerms: string[],
): number {
	let score = 0;
	for (const term of queryTerms) {
		const tf = doc.bodyTermFreq.get(term) ?? 0;
		const df = input.docFreq.get(term) ?? 0;
		let fieldHit = 0;
		if (doc.titleTerms.has(term)) fieldHit += fieldBoost.title;
		if (doc.headingTerms.has(term)) fieldHit += fieldBoost.heading;
		if (doc.pathTerms.has(term)) fieldHit += fieldBoost.path;
		if (doc.frontmatterTerms.has(term)) fieldHit += fieldBoost.frontmatter;
		if (tf === 0 && fieldHit === 0) continue;
		// idf clamped non-negative so corpus-wide terms never push scores below 0
		const idf = Math.max(
			0,
			Math.log(1 + (input.totalDocs - df + 0.5) / (df + 0.5)),
		);
		const norm =
			input.avgBodyLength > 0
				? bm25K1 * (1 - bm25B + bm25B * (doc.bodyLength / input.avgBodyLength))
				: bm25K1;
		const bodyScore = idf * ((tf * (bm25K1 + 1)) / (tf + norm));
		score += bodyScore + idf * fieldHit;
	}
	if (score <= 0) return 0;
	// penalize low-confidence and injection-signal pages so clean, high-quality
	// sources rank first without hiding flagged ones entirely
	const confidence = doc.record.confidence ?? 0.5;
	const confidencePenalty = 0.5 + 0.5 * clamp01(confidence);
	const injectionPenalty = doc.record.injectionSignals.length > 0 ? 0.6 : 1;
	return score * confidencePenalty * injectionPenalty;
}

function toPageDoc(
	record: CorpusPage & { outputPath: string },
	source: string,
): PageDoc {
	const { frontmatter, body } = splitFrontmatter(source);
	const bodyTermFreq = new Map<string, number>();
	let bodyLength = 0;
	for (const term of tokenizeBounded(body, maxTermsPerField)) {
		bodyTermFreq.set(term, (bodyTermFreq.get(term) ?? 0) + 1);
		bodyLength++;
	}
	return {
		record,
		body,
		titleTerms: new Set(tokenize(record.title ?? "")),
		headingTerms: collectHeadingTerms(body),
		pathTerms: new Set(tokenize(record.outputPath.replace(/[/\\.]/g, " "))),
		frontmatterTerms: new Set(tokenizeBounded(frontmatter, maxTermsPerField)),
		bodyTermFreq,
		bodyLength,
	};
}

// headings drive intent: collect terms from Markdown ATX headings only, scanning
// line starts without a global RegExp over the page body
function collectHeadingTerms(body: string): Set<string> {
	const terms = new Set<string>();
	let lineStart = 0;
	let headings = 0;
	while (lineStart < body.length && headings < 500) {
		let nl = body.indexOf("\n", lineStart);
		if (nl === -1) nl = body.length;
		if (body[lineStart] === "#") {
			const line = body.slice(lineStart, nl);
			for (const term of tokenize(line)) terms.add(term);
			headings++;
		}
		lineStart = nl + 1;
	}
	return terms;
}

// char-by-char ASCII-ish tokenizer: lowercases, keeps alphanumerics, splits on
// everything else. No RegExp over untrusted text, and bounded by callers.
function tokenize(value: string): string[] {
	return tokenizeBounded(value, Number.POSITIVE_INFINITY);
}

function tokenizeBounded(value: string, maxTokens: number): string[] {
	const tokens: string[] = [];
	let current = "";
	for (let i = 0; i < value.length; i++) {
		const code = value.charCodeAt(i);
		const isDigit = code >= 48 && code <= 57;
		const isUpper = code >= 65 && code <= 90;
		const isLower = code >= 97 && code <= 122;
		if (isDigit || isLower) {
			current += value.charAt(i);
		} else if (isUpper) {
			current += String.fromCharCode(code + 32);
		} else if (code > 127) {
			// keep non-ASCII letters intact (e.g. accented docs) but lowercased
			current += value.charAt(i).toLowerCase();
		} else {
			if (current) {
				pushToken(tokens, current);
				current = "";
				if (tokens.length >= maxTokens) return tokens;
			}
		}
	}
	if (current && tokens.length < maxTokens) pushToken(tokens, current);
	return tokens;
}

function pushToken(tokens: string[], token: string): void {
	if (token.length < minTermLength || token.length > maxTermLength) return;
	tokens.push(token);
}

function splitFrontmatter(source: string): {
	frontmatter: string;
	body: string;
} {
	if (!source.startsWith("---\n")) return { frontmatter: "", body: source };
	const end = source.indexOf("\n---\n", 4);
	if (end < 0) return { frontmatter: "", body: source };
	return {
		frontmatter: source.slice(4, end),
		body: source.slice(end + 5),
	};
}

// pick the densest window of query-term hits, then expand to char bounds and map
// back to 1-based line numbers for stable citations
function bestSnippet(
	body: string,
	queryTerms: Set<string>,
	snippetChars: number,
): { lineStart: number; lineEnd: number; text: string } {
	const hit = firstDenseHit(body, queryTerms);
	const center = hit >= 0 ? hit : 0;
	const half = Math.floor(snippetChars / 2);
	let start = Math.max(0, center - half);
	let end = Math.min(body.length, start + snippetChars);
	start = expandToLineStart(body, start);
	end = expandToLineEnd(body, end);
	const text = body.slice(start, end).trim();
	return {
		lineStart: lineNumberAt(body, start),
		lineEnd: lineNumberAt(body, end),
		text,
	};
}

// scan windows of body tokens (bounded) for the position with the most distinct
// query-term hits; returns a char offset near that window
function firstDenseHit(body: string, queryTerms: Set<string>): number {
	let bestOffset = -1;
	let bestHits = 0;
	let current = "";
	let tokenStart = 0;
	let scanned = 0;
	let windowHits = new Set<string>();
	let windowStart = 0;
	const flush = () => {
		if (!current) return;
		const term = current.toLowerCase();
		if (queryTerms.has(term)) {
			windowHits.add(term);
			if (windowHits.size > bestHits) {
				bestHits = windowHits.size;
				bestOffset = tokenStart;
			}
		}
		scanned++;
		// slide a coarse window every 40 tokens to keep hit clusters local
		if (scanned - windowStart >= 40) {
			windowHits = new Set();
			windowStart = scanned;
		}
		current = "";
	};
	for (let i = 0; i < body.length; i++) {
		const ch = body.charCodeAt(i);
		const isWord =
			(ch >= 48 && ch <= 57) ||
			(ch >= 65 && ch <= 90) ||
			(ch >= 97 && ch <= 122) ||
			ch > 127;
		if (isWord) {
			if (!current) tokenStart = i;
			current += body.charAt(i);
		} else {
			flush();
		}
	}
	flush();
	return bestOffset;
}

function expandToLineStart(body: string, index: number): number {
	const nl = body.lastIndexOf("\n", index);
	return nl < 0 ? 0 : nl + 1;
}

function expandToLineEnd(body: string, index: number): number {
	const nl = body.indexOf("\n", index);
	return nl < 0 ? body.length : nl;
}

function lineNumberAt(text: string, index: number): number {
	let line = 1;
	for (let i = 0; i < index && i < text.length; i++) {
		if (text[i] === "\n") line++;
	}
	return line;
}

function clamp01(value: number): number {
	if (Number.isNaN(value)) return 0;
	return Math.max(0, Math.min(1, value));
}
