import { hashContent } from "../core/snapshot.ts";
import type { CorpusPage } from "../corpus/index.ts";
import { docSnippet, lineNumberAt } from "./snippets.ts";

type PageRecord = CorpusPage & { outputPath: string };

type RankedSnippet = {
	record: PageRecord;
	contentHash: string;
	extractor: string;
	score: number;
	confidence: number;
	lineStart: number;
	lineEnd: number;
	text: string;
};

type RankInput = {
	pages: PageDoc[];
	totalDocs: number;
	avgBodyLength: number;
	docFreq: Map<string, number>;
};

type PageDoc = {
	record: PageRecord;
	body: string;
	bodyLineOffset: number;
	frontmatter: string;
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
const maxTermsPerField = 32_000;
const maxQueryChars = 500;
const maxQueryTerms = 32;
const minTermLength = 2;
const maxTermLength = 48;
const stopTerms = new Set(
	"a about an and are as at be by can could describe did do docs document does explain for from how in is it me of on or page should summarize summary tell the these this to use what when where which who why will with would you your".split(
		" ",
	),
);

type PageLoader = (record: PageRecord) => Promise<string | null>;

type CandidateFilter = { terms: string[] };

type SplitFrontmatter = {
	frontmatter: { text: string; lineOffset: number };
	body: string;
};

export async function buildRankInput(
	records: CorpusPage[],
	load: PageLoader,
	limits: { maxPages: number; maxBytes: number },
	options: { query?: string } = {},
): Promise<{ input: RankInput; truncated: boolean; skipped: number }> {
	if (options.query) assertSearchQuery(options.query);
	const filter = candidateFilter(options.query);
	const pages: PageDoc[] = [];
	const docFreq = new Map<string, number>();
	let scannedBytes = 0;
	let totalBodyLength = 0;
	let truncated = false;
	let skipped = 0;
	for (const record of records) {
		if (!isPageRecord(record)) continue;
		if (pages.length >= limits.maxPages || scannedBytes >= limits.maxBytes) {
			truncated = true;
			break;
		}
		const source = await load(record);
		if (source === null) {
			skipped++;
			continue;
		}
		scannedBytes += Buffer.byteLength(source);
		if (filter.terms.length && !candidateTextMatches(record, source, filter)) {
			continue;
		}
		const doc = toPageDoc(record, source);
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
		skipped,
	};
}

export function assertSearchQuery(query: string) {
	if (query.length > maxQueryChars)
		throw new Error(`query must be ${maxQueryChars} characters or fewer`);
}

function isPageRecord(record: CorpusPage): record is PageRecord {
	return record.ok && Boolean(record.outputPath);
}

function candidateFilter(query: string | undefined): CandidateFilter {
	if (!query) return { terms: [] };
	const queryTerms = tokenize(query).slice(0, maxQueryTerms);
	const meaningful = meaningfulQueryTerms(queryTerms);
	return { terms: meaningful.length ? meaningful : queryTerms };
}

function candidateTextMatches(
	record: PageRecord,
	source: string,
	filter: CandidateFilter,
): boolean {
	const metadata =
		`${record.title ?? ""}\n${record.url}\n${record.finalUrl}\n${record.outputPath}`.toLowerCase();
	if (filter.terms.some((term) => metadata.includes(term))) return true;
	const body = source.toLowerCase();
	return filter.terms.some((term) => body.includes(term));
}

export function rankPages(
	input: RankInput,
	query: string,
	options: {
		maxResults: number;
		snippetChars: number;
		preferredOutputPaths?: ReadonlySet<string>;
	},
): RankedSnippet[] {
	const queryTerms = tokenize(query).slice(0, maxQueryTerms);
	if (queryTerms.length === 0) return [];
	const requiredTerms = meaningfulQueryTerms(queryTerms);
	const snippetSource = requiredTerms.length ? requiredTerms : queryTerms;
	const snippetTerms = new Set(snippetSource);
	const distinctiveTerms = requiredTerms.filter((term) => term.length >= 8);
	const literalTerms = queryLiteralTerms(query);
	const strictHits = minRequiredHits(requiredTerms.length);
	const requiredHits =
		requiredTerms.length === 2 &&
		!input.pages.some((doc) => countTermHits(doc, requiredTerms) >= strictHits)
			? 1
			: strictHits;
	const scored: RankedSnippet[] = [];
	for (const doc of input.pages) {
		const hitCount = countTermHits(doc, requiredTerms);
		if (requiredHits > 0 && hitCount < requiredHits) continue;
		if (distinctiveTerms.length && !countTermHits(doc, distinctiveTerms))
			continue;
		const score =
			scoreDoc(input, doc, queryTerms) *
			literalTermBoost(doc, literalTerms) *
			preferredPageBoost(doc, options.preferredOutputPaths);
		if (score <= 0) continue;
		const snippet = docSnippet(
			doc,
			snippetTerms,
			options.snippetChars,
			literalTerms,
		);
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
	scored.sort(
		(a, b) =>
			b.score - a.score ||
			a.record.outputPath.localeCompare(b.record.outputPath),
	);
	return scored.slice(0, options.maxResults);
}

function preferredPageBoost(
	doc: PageDoc,
	preferredOutputPaths: ReadonlySet<string> | undefined,
) {
	return preferredOutputPaths?.has(doc.record.outputPath) ? 1.15 : 1;
}

function queryLiteralTerms(query: string): string[] {
	return query
		.toLowerCase()
		.split(/\s+/)
		.filter((term) => term.length > 2 && /[-_.@/]/.test(term))
		.slice(0, 8);
}

function literalTermBoost(doc: PageDoc, terms: string[]): number {
	if (!terms.length) return 1;
	const haystack =
		`${doc.record.title ?? ""}\n${doc.record.outputPath}\n${doc.frontmatter}\n${doc.body}`.toLowerCase();
	let hits = 0;
	for (const term of terms) {
		if (haystack.includes(term)) hits++;
	}
	return hits ? 1 + Math.min(2, hits * 1.75) : 1;
}

function meaningfulQueryTerms(queryTerms: string[]): string[] {
	return [...new Set(queryTerms.filter((term) => !stopTerms.has(term)))];
}

function minRequiredHits(termCount: number): number {
	if (termCount <= 2) return termCount;
	if (termCount <= 5) return termCount - 1;
	return Math.ceil(termCount * 0.65);
}

function countTermHits(doc: PageDoc, terms: string[]): number {
	let hits = 0;
	for (const term of terms) {
		if (
			doc.bodyTermFreq.has(term) ||
			doc.titleTerms.has(term) ||
			doc.headingTerms.has(term) ||
			doc.pathTerms.has(term) ||
			doc.frontmatterTerms.has(term)
		) {
			hits++;
		}
	}
	return hits;
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
	const confidence = doc.record.confidence ?? 0.5;
	const confidencePenalty = 0.5 + 0.5 * clamp01(confidence);
	const injectionPenalty = doc.record.injectionSignals.length > 0 ? 0.6 : 1;
	return score * confidencePenalty * injectionPenalty;
}

function toPageDoc(record: PageRecord, source: string): PageDoc {
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
		bodyLineOffset: frontmatter.lineOffset,
		frontmatter: frontmatter.text,
		titleTerms: new Set(tokenize(record.title ?? "")),
		headingTerms: collectHeadingTerms(body),
		pathTerms: new Set(tokenize(record.outputPath.replace(/[/\\.]/g, " "))),
		frontmatterTerms: new Set(
			tokenizeBounded(frontmatter.text, maxTermsPerField),
		),
		bodyTermFreq,
		bodyLength,
	};
}

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

function splitFrontmatter(source: string): SplitFrontmatter {
	if (!source.startsWith("---\n"))
		return { frontmatter: { text: "", lineOffset: 0 }, body: source };
	const end = source.indexOf("\n---\n", 4);
	if (end < 0)
		return { frontmatter: { text: "", lineOffset: 0 }, body: source };
	const bodyStart = end + 5;
	return {
		frontmatter: {
			text: source.slice(4, end),
			lineOffset: lineNumberAt(source, bodyStart) - 1,
		},
		body: source.slice(bodyStart),
	};
}

function clamp01(value: number): number {
	if (Number.isNaN(value)) return 0;
	return Math.max(0, Math.min(1, value));
}
