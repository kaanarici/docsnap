import { isJsonObject, isJsonString, type JsonValue } from "../core/json.ts";
import { uniqueByWhitespace, whitespaceKey, wordCount } from "../core/text.ts";
import type { InlineStateSource } from "../core/types.ts";
import {
	assignedExpression,
	decodeLooseEscapes,
	nextFlightChunks,
	parseJson,
	parseJsonExpression,
	type ScriptBlock,
	stringLiterals,
} from "./inline-state-scan.ts";
import { cleanInlineText, looksLikeTailwind } from "./inline-state-text.ts";

type TextCandidate = {
	text: string;
	kind: "heading" | "paragraph";
	weight: number;
};

type ExtractionCandidate = {
	markdown: string;
	source: InlineStateSource;
	words: number;
	weight: number;
};

const maxWalkNodes = 8_000;
const maxParagraphs = 180;
const headingKeys = new Set([
	"headline",
	"name",
	"title",
	"heading",
	"label",
	"question",
]);
const proseKeys = new Set([
	"articleBody",
	"text",
	"description",
	"body",
	"bodyText",
	"plainText",
	"children",
	"answer",
]);

export function extractInlineState(
	html: string,
	url: string,
	prepared: { scripts: ScriptBlock[]; title: string | undefined },
): { markdown: string; source: InlineStateSource } | undefined {
	const scripts = prepared.scripts;
	const title = prepared.title ?? titleFromUrl(url);
	const candidates = [
		jsonScriptCandidate(scripts, title, "__NEXT_DATA__", "next-data"),
		rscCandidate(html, title),
		assignmentCandidate(scripts, title, "nuxt", ["__NUXT__"]),
		jsonScriptCandidate(scripts, title, "__NUXT_DATA__", "nuxt"),
		assignmentCandidate(scripts, title, "remix", ["__remixContext"]),
		assignmentCandidate(scripts, title, "redux", [
			"__PRELOADED_STATE__",
			"__APOLLO_STATE__",
		]),
		ldJsonCandidate(scripts, title),
		genericJsonCandidate(scripts, title),
	].filter((candidate): candidate is ExtractionCandidate => Boolean(candidate));
	if (candidates.length === 0) return undefined;
	const best = candidates.sort(
		(a, b) => b.words - a.words || b.weight - a.weight,
	)[0]!;
	return { markdown: best.markdown, source: best.source };
}

function rscCandidate(html: string, title: string | undefined) {
	const payload = nextFlightChunks(html).join("");
	if (!payload) return undefined;
	const texts: TextCandidate[] = [];
	for (const value of stringLiterals(decodeLooseEscapes(payload))) {
		addReadable(texts, value, "", "rsc");
	}
	return assembleCandidate("rsc", title, texts);
}

function assignmentCandidate(
	scripts: ScriptBlock[],
	title: string | undefined,
	source: InlineStateSource,
	names: string[],
) {
	for (const script of scripts) {
		for (const name of names) {
			const expression = assignedExpression(script.body, name);
			if (!expression) continue;
			const parsed = parseJsonExpression(expression);
			if (parsed !== undefined) return objectCandidate(source, title, parsed);
			const texts: TextCandidate[] = [];
			for (const value of stringLiterals(expression)) {
				addReadable(texts, value, "", source);
			}
			const candidate = assembleCandidate(source, title, texts);
			if (candidate) return candidate;
		}
	}
	return undefined;
}

function ldJsonCandidate(scripts: ScriptBlock[], title: string | undefined) {
	const texts: TextCandidate[] = [];
	for (const script of scripts) {
		if (!/\bapplication\/ld\+json\b/i.test(script.type)) continue;
		const parsed = parseJson(script.body);
		if (parsed === undefined) continue;
		collectStructuredData(parsed, texts);
	}
	return assembleCandidate("ld-json", title, texts);
}

function genericJsonCandidate(
	scripts: ScriptBlock[],
	title: string | undefined,
) {
	const texts: TextCandidate[] = [];
	for (const script of scripts) {
		if (
			script.id === "__NEXT_DATA__" ||
			script.id === "__NUXT_DATA__" ||
			/\bapplication\/ld\+json\b/i.test(script.type) ||
			!/\bapplication\/json\b/i.test(script.type)
		) {
			continue;
		}
		const parsed = parseJson(script.body);
		if (parsed !== undefined) collectValue(parsed, texts);
	}
	return assembleCandidate("json", title, texts);
}

function jsonScriptCandidate(
	scripts: ScriptBlock[],
	title: string | undefined,
	id: string,
	source: InlineStateSource,
) {
	const script = scripts.find((item) => item.id === id);
	if (!script) return undefined;
	const parsed = parseJson(script.body);
	return parsed === undefined
		? undefined
		: objectCandidate(source, title, parsed);
}

function objectCandidate(
	source: InlineStateSource,
	title: string | undefined,
	value: JsonValue,
) {
	const texts: TextCandidate[] = [];
	collectValue(value, texts);
	return assembleCandidate(source, title, texts);
}

function collectStructuredData(value: JsonValue, out: TextCandidate[]): void {
	const items = Array.isArray(value) ? value : [value];
	for (const item of items) {
		if (!isJsonObject(item)) continue;
		const graph = Array.isArray(item["@graph"]) ? item["@graph"] : [item];
		for (const entry of graph) collectStructuredEntry(entry, out);
	}
}

function collectStructuredEntry(value: JsonValue, out: TextCandidate[]) {
	if (!isJsonObject(value)) return;
	const object = value;
	if (!structuredType(object["@type"])) return;
	for (const key of [
		"headline",
		"name",
		"description",
		"articleBody",
		"text",
	]) {
		const item = object[key];
		if (isJsonString(item)) addReadable(out, item, key, "ld-json");
	}
	for (const entity of arrayValue(object["mainEntity"])) {
		if (!isJsonObject(entity)) continue;
		if (isJsonString(entity["name"]))
			addReadable(out, entity["name"], "question", "ld-json");
		const answer = entity["acceptedAnswer"];
		if (isJsonObject(answer)) {
			if (isJsonString(answer["text"]))
				addReadable(out, answer["text"], "answer", "ld-json");
		}
	}
	for (const step of arrayValue(object["step"])) {
		if (isJsonString(step)) addReadable(out, step, "text", "ld-json");
		else if (isJsonObject(step)) {
			for (const key of ["name", "text"]) {
				if (isJsonString(step[key]))
					addReadable(out, step[key], key, "ld-json");
			}
		}
	}
}

function collectValue(
	value: JsonValue,
	out: TextCandidate[],
	key = "",
	state = { nodes: 0 },
): void {
	if (state.nodes++ > maxWalkNodes) return;
	if (isJsonString(value)) {
		if (value.length > 2_000) {
			for (const item of stringLiterals(decodeLooseEscapes(value))) {
				addReadable(out, item, key, "json");
			}
		}
		addReadable(out, value, key, "json");
		return;
	}
	if (Array.isArray(value)) {
		for (const item of value) collectValue(item, out, key, state);
		return;
	}
	if (!isJsonObject(value)) return;
	for (const [childKey, item] of Object.entries(value)) {
		if (skipKey(childKey)) continue;
		collectValue(item, out, childKey, state);
	}
}

function addReadable(
	out: TextCandidate[],
	value: string,
	key: string,
	source: InlineStateSource,
) {
	const text = cleanInlineText(value);
	if (!readableText(text, key, source)) return;
	out.push({
		text,
		kind: headingKeys.has(key) ? "heading" : "paragraph",
		weight: proseKeys.has(key) || headingKeys.has(key) ? 2 : 1,
	});
}

function assembleCandidate(
	source: InlineStateSource,
	title: string | undefined,
	texts: TextCandidate[],
): ExtractionCandidate | undefined {
	const normalizedTitle = title ? headingText(title) : undefined;
	const normalizedTitleKey = normalizedTitle?.toLowerCase();
	const seen = new Set<string>();
	const body: TextCandidate[] = [];
	const comparableByLead = new Map<string, ComparableText[]>();
	let proseWords = 0;
	let weight = 0;
	for (const item of texts) {
		const key = whitespaceKey(item.text).toLowerCase();
		if (!key || key === normalizedTitleKey || seen.has(key)) continue;
		const comparable = comparableText(item.text);
		const matches = comparable
			? comparableByLead.get(comparable.lead)
			: undefined;
		if (
			comparable &&
			matches?.some((existing) => nearDuplicate(comparable, existing))
		)
			continue;
		seen.add(key);
		body.push(item);
		if (item.kind === "paragraph") proseWords += wordCount(item.text);
		weight += item.weight;
		if (comparable) {
			const group = matches ?? [];
			group.push(comparable);
			comparableByLead.set(comparable.lead, group);
		}
		if (body.length >= maxParagraphs) break;
	}
	if (proseWords < 30) return undefined;
	const parts = [
		normalizedTitle ? `# ${normalizedTitle}` : undefined,
		...body.map((item) =>
			item.kind === "heading" ? `## ${headingText(item.text)}` : item.text,
		),
	].filter((item): item is string => Boolean(item?.trim()));
	const markdown = uniqueByWhitespace(parts).join("\n\n").trim();
	if (wordCount(markdown) < 40) return undefined;
	return {
		markdown,
		source,
		words: proseWords,
		weight,
	};
}

type ComparableText = {
	lead: string;
	words: Set<string>;
};

function nearDuplicate(left: ComparableText, right: ComparableText) {
	const minimum = Math.min(left.words.size, right.words.size);
	let overlap = 0;
	for (const word of left.words) {
		if (right.words.has(word) && ++overlap / minimum >= 0.55) return true;
	}
	return false;
}

function comparableText(text: string): ComparableText | undefined {
	const words = (text.toLowerCase().match(/[a-z0-9]+/g) ?? []).map((word) =>
		/\d/.test(word) ? "#" : word,
	);
	if (words.length < 10) return;
	return { lead: words.slice(0, 5).join(" "), words: new Set(words) };
}

function readableText(
	text: string,
	key: string,
	source: InlineStateSource,
): boolean {
	if (!/[A-Za-z]{2}/.test(text) || !text.includes(" ")) return false;
	if (looksLikeUrlOrPath(text) || looksLikeCodeOrStyle(text)) return false;
	if (looksLikeTailwind(text)) return false;
	if (looksLikeIdentifier(text)) return false;
	const words = wordCount(text);
	if (headingKeys.has(key))
		return words >= 2 && words <= 18 && text.length <= 180;
	if (text.length < 18 || text.length > 8_000) return false;
	if (source === "ld-json" && proseKeys.has(key)) return words >= 5;
	if (words < 6) return false;
	return /[.!?](?:\s|$)/.test(text) || (words >= 9 && commonProseWords(text));
}

function headingText(value: string) {
	return cleanInlineText(value).replace(
		/\s*[|·-]\s*(?:Docs?|Documentation).*$/i,
		"",
	);
}

function titleFromUrl(url: string) {
	try {
		const slug = new URL(url).pathname.split("/").filter(Boolean).pop();
		return slug?.replace(/[-_]+/g, " ");
	} catch {
		return undefined;
	}
}

function looksLikeUrlOrPath(text: string) {
	return (
		/^(?:https?:|data:|mailto:|\/|#)/i.test(text) ||
		/\.(?:css|js|mjs|map|woff2?|png|jpe?g|webp|gif|svg)(?:[?#]|$)/i.test(text)
	);
}

function looksLikeIdentifier(text: string) {
	return (
		/^[A-Z0-9_.$:-]+$/.test(text) ||
		/^[a-f0-9]{16,}$/i.test(text) ||
		/^[a-z0-9_-]{20,}$/i.test(text) ||
		/\b(?:webpack|chunk|module|runtime|buildId|nonce)\b/i.test(text)
	);
}

function looksLikeCodeOrStyle(text: string) {
	return (
		/[{};]/.test(text) ||
		/\b(?:@media|calc\(|rgba?\(|hsla?\(|var\(--|font-family)\b/i.test(text) ||
		/(?:^|\s)(?:width|height|color|display|position|margin|padding):/i.test(
			text,
		) ||
		/(?:className|data-|aria-|xmlns|viewBox|strokeWidth)/.test(text)
	);
}

function commonProseWords(text: string) {
	return /\b(?:the|and|for|with|from|your|you|can|will|how|when|using|create|build|learn|application|documentation|component|server|client)\b/i.test(
		text,
	);
}

function skipKey(key: string) {
	return /^(?:className|class|style|styles|href|src|url|path|slug|id|key|ref|icon|image|images|metadata|css|font|color|theme|viewport|robots)$/i.test(
		key,
	);
}

function structuredType(value: JsonValue | undefined) {
	const types = Array.isArray(value) ? value : [value];
	return types.some(
		(type) =>
			isJsonString(type) &&
			/^(?:Article|TechArticle|WebPage|FAQPage|HowTo|Question|Answer)$/i.test(
				type,
			),
	);
}

function arrayValue(value: JsonValue | undefined): JsonValue[] {
	return value === undefined ? [] : Array.isArray(value) ? value : [value];
}
