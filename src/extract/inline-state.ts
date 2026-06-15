import { uniqueByWhitespace, whitespaceKey, wordCount } from "../core/text.ts";
import type { InlineStateSource } from "../core/types.ts";
import {
	assignedExpression,
	decodeLooseEscapes,
	htmlTitle,
	nextFlightChunks,
	parseJson,
	parseJsonExpression,
	type ScriptBlock,
	scriptBlocks,
	stringLiterals,
} from "./inline-state-scan.ts";
import { cleanInlineText, looksLikeTailwind } from "./inline-state-text.ts";

type TextKind = "heading" | "paragraph";

type TextCandidate = {
	text: string;
	kind: TextKind;
	weight: number;
};

type ExtractionCandidate = {
	markdown: string;
	source: InlineStateSource;
	words: number;
	weight: number;
};

type StructuredObject = Record<string, unknown> & {
	mainEntity?: unknown;
	step?: unknown;
};

type QuestionObject = Record<string, unknown> & {
	acceptedAnswer?: unknown;
	name?: unknown;
};

type AnswerObject = Record<string, unknown> & {
	text?: unknown;
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
): { markdown: string; source: InlineStateSource } | undefined {
	const scripts = scriptBlocks(html);
	const title = htmlTitle(html) ?? titleFromUrl(url);
	const candidates = [
		nextDataCandidate(scripts, title),
		rscCandidate(html, title),
		assignmentCandidate(scripts, title, "nuxt", ["__NUXT__"]),
		nuxtDataCandidate(scripts, title),
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

function nextDataCandidate(scripts: ScriptBlock[], title: string | undefined) {
	const script = scripts.find((item) => item.id === "__NEXT_DATA__");
	if (!script) return undefined;
	return parsedJsonCandidate("next-data", title, script.body);
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

function nuxtDataCandidate(scripts: ScriptBlock[], title: string | undefined) {
	const script = scripts.find((item) => item.id === "__NUXT_DATA__");
	if (!script) return undefined;
	return parsedJsonCandidate("nuxt", title, script.body);
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
		if (parsed !== undefined) collectValue(parsed, texts, [], { nodes: 0 });
	}
	return assembleCandidate("json", title, texts);
}

function parsedJsonCandidate(
	source: InlineStateSource,
	title: string | undefined,
	body: string,
) {
	const parsed = parseJson(body);
	return parsed === undefined
		? undefined
		: objectCandidate(source, title, parsed);
}

function objectCandidate(
	source: InlineStateSource,
	title: string | undefined,
	value: unknown,
) {
	const texts: TextCandidate[] = [];
	collectValue(value, texts, [], { nodes: 0 });
	return assembleCandidate(source, title, texts);
}

function collectStructuredData(value: unknown, out: TextCandidate[]): void {
	const items = Array.isArray(value) ? value : [value];
	for (const item of items) {
		if (!item || typeof item !== "object") continue;
		const graph = Array.isArray((item as Record<string, unknown>)["@graph"])
			? ((item as Record<string, unknown>)["@graph"] as unknown[])
			: [item];
		for (const entry of graph) collectStructuredEntry(entry, out);
	}
}

function collectStructuredEntry(value: unknown, out: TextCandidate[]) {
	if (!value || typeof value !== "object") return;
	const object = value as StructuredObject;
	if (!structuredType(object["@type"])) return;
	for (const key of [
		"headline",
		"name",
		"description",
		"articleBody",
		"text",
	]) {
		const item = object[key];
		if (typeof item === "string") addReadable(out, item, key, "ld-json");
	}
	const entities = arrayValue(object.mainEntity);
	for (const entity of entities) {
		if (!entity || typeof entity !== "object") continue;
		const question = entity as QuestionObject;
		if (typeof question.name === "string")
			addReadable(out, question.name, "question", "ld-json");
		const answer = question.acceptedAnswer;
		if (answer && typeof answer === "object") {
			const text = (answer as AnswerObject).text;
			if (typeof text === "string") addReadable(out, text, "answer", "ld-json");
		}
	}
	for (const step of arrayValue(object.step)) {
		if (typeof step === "string") addReadable(out, step, "text", "ld-json");
		else if (step && typeof step === "object") {
			const stepObject = step as Record<string, unknown>;
			for (const key of ["name", "text"]) {
				if (typeof stepObject[key] === "string")
					addReadable(out, stepObject[key] as string, key, "ld-json");
			}
		}
	}
}

function collectValue(
	value: unknown,
	out: TextCandidate[],
	path: string[],
	state: { nodes: number },
): void {
	if (state.nodes++ > maxWalkNodes) return;
	if (typeof value === "string") {
		const key = path.at(-1) ?? "";
		if (value.length > 2_000) {
			for (const item of stringLiterals(decodeLooseEscapes(value))) {
				addReadable(out, item, key, "json");
			}
		}
		addReadable(out, value, key, "json");
		return;
	}
	if (Array.isArray(value)) {
		for (const item of value) collectValue(item, out, path, state);
		return;
	}
	if (!value || typeof value !== "object") return;
	for (const [key, item] of Object.entries(value)) {
		if (skipKey(key)) continue;
		collectValue(item, out, [...path, key], state);
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
	const seen = new Set<string>();
	const body: TextCandidate[] = [];
	for (const item of texts) {
		const key = whitespaceKey(item.text).toLowerCase();
		if (!key || key === normalizedTitle?.toLowerCase() || seen.has(key))
			continue;
		seen.add(key);
		body.push(item);
		if (body.length >= maxParagraphs) break;
	}
	const proseWords = wordCount(
		body
			.filter((item) => item.kind === "paragraph")
			.map((item) => item.text)
			.join(" "),
	);
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
		weight: body.reduce((sum, item) => sum + item.weight, 0),
	};
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

function structuredType(value: unknown) {
	const types = Array.isArray(value) ? value : [value];
	return types.some(
		(type) =>
			typeof type === "string" &&
			/^(?:Article|TechArticle|WebPage|FAQPage|HowTo|Question|Answer)$/i.test(
				type,
			),
	);
}

function arrayValue(value: unknown) {
	if (Array.isArray(value)) return value;
	return value === undefined ? [] : [value];
}
