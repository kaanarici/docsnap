import { isJsonString, type JsonValue, parseJsonValue } from "../core/json.ts";
import { escapeRegExp } from "../core/text.ts";

export type ScriptBlock = {
	id: string;
	type: string;
	body: string;
};

const nextFlightPush = "self.__next_f.push(";
const maxNextFlightScanBytes = 4 * 1024 * 1024;
const maxNextFlightChunks = 4_096;

export function scriptBlocks(document: Document): ScriptBlock[] {
	return Array.from(document.querySelectorAll("script")).map((script) => ({
		id: script.getAttribute("id") ?? "",
		type: script.getAttribute("type") ?? "",
		body: script.textContent ?? "",
	}));
}

export function nextFlightChunks(html: string): string[] {
	const chunks: string[] = [];
	let cursor = 0;
	let scanned = 0;
	let chunkCount = 0;
	while (scanned < maxNextFlightScanBytes && chunkCount < maxNextFlightChunks) {
		const match = html.indexOf(nextFlightPush, cursor);
		if (match === -1) break;
		const start = match + nextFlightPush.length;
		const scanEnd = Math.min(
			html.length,
			start + maxNextFlightScanBytes - scanned,
		);
		const argument = balancedExpression(html, start, scanEnd);
		scanned += argument.end - start;
		cursor = Math.max(argument.end, start + 1);
		chunkCount++;
		if (!argument.value) continue;
		const parsed = parseJson(argument.value);
		if (Array.isArray(parsed)) {
			for (const item of parsed) {
				if (isJsonString(item)) chunks.push(item);
			}
			continue;
		}
		for (const literal of stringLiterals(argument.value)) chunks.push(literal);
	}
	return chunks;
}

export function assignedExpression(body: string, name: string) {
	const match = new RegExp(`(?:window\\.)?${escapeRegExp(name)}\\s*=\\s*`).exec(
		body,
	);
	if (!match) return undefined;
	return balancedExpression(body, match.index + match[0].length).value;
}

export function parseJsonExpression(expression: string) {
	const parsed = parseJson(expression);
	if (parsed !== undefined) return parsed;
	const jsonParse = /^JSON\.parse\(\s*("(?:\\.|[^"\\])*")\s*\)$/s.exec(
		expression.trim(),
	);
	if (!jsonParse) return undefined;
	return parseJson(decodeStringLiteral(jsonParse[1]!));
}

export function parseJson(value: string): JsonValue | undefined {
	try {
		return parseJsonValue(value.trim());
	} catch {
		return undefined;
	}
}

export function* stringLiterals(input: string) {
	for (const match of input.matchAll(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g)) {
		const decoded = decodeStringLiteral(match[0]);
		if (decoded) yield decoded;
	}
}

export function decodeLooseEscapes(value: string) {
	return value
		.replace(/\\u([0-9a-fA-F]{4})/g, (_, hex: string) =>
			String.fromCharCode(Number.parseInt(hex, 16)),
		)
		.replace(/\\x([0-9a-fA-F]{2})/g, (_, hex: string) =>
			String.fromCharCode(Number.parseInt(hex, 16)),
		)
		.replace(/\\n/g, "\n")
		.replace(/\\t/g, "\t")
		.replace(/\\"/g, '"');
}

export function decodeEntities(value: string) {
	return value.replace(
		/&(?:#x([0-9a-f]+)|#([0-9]+)|nbsp|amp|lt|gt|quot|apos);/gi,
		(entity, hex: string | undefined, decimal: string | undefined) => {
			if (hex || decimal) {
				const code = Number.parseInt(hex ?? decimal ?? "", hex ? 16 : 10);
				return Number.isInteger(code) && code >= 0 && code <= 0x10ffff
					? String.fromCodePoint(code)
					: "";
			}
			return namedEntities.get(entity.toLowerCase()) ?? entity;
		},
	);
}

const namedEntities = new Map([
	["&nbsp;", " "],
	["&amp;", "&"],
	["&lt;", "<"],
	["&gt;", ">"],
	["&quot;", '"'],
	["&apos;", "'"],
]);

type BalancedExpression = {
	value?: string;
	end: number;
};

export function balancedExpression(
	input: string,
	start: number,
	maxEnd = input.length,
): BalancedExpression {
	const limit = Math.min(input.length, Math.max(start, maxEnd));
	const opening = input[start];
	const pairIndex = opening ? "{[(".indexOf(opening) : -1;
	const closing = pairIndex < 0 ? undefined : "}])"[pairIndex];
	if (!closing) return untilSemicolon(input, start, limit);
	let depth = 0;
	let quote = "";
	let escaped = false;
	for (let index = start; index < limit; index++) {
		const char = input[index]!;
		if (quote) {
			if (escaped) {
				escaped = false;
				continue;
			}
			if (char === "\\") {
				escaped = true;
				continue;
			}
			if (char === quote) quote = "";
			continue;
		}
		if (char === '"' || char === "'" || char === "`") {
			quote = char;
			continue;
		}
		if (char === opening) depth++;
		if (char === closing && --depth === 0)
			return { value: input.slice(start, index + 1), end: index + 1 };
	}
	return { end: limit };
}

function untilSemicolon(input: string, start: number, maxEnd: number) {
	const end = input.indexOf(";", start);
	const expressionEnd = Math.min(end === -1 ? input.length : end, maxEnd);
	return {
		value: input.slice(start, expressionEnd).trim(),
		end: expressionEnd,
	};
}

function decodeStringLiteral(literal: string) {
	try {
		const json = literal.startsWith('"')
			? literal
			: `"${literal.slice(1, -1).replace(/\\'/g, "'").replace(/"/g, '\\"')}"`;
		const parsed = parseJsonValue(json);
		return isJsonString(parsed) ? parsed : "";
	} catch {
		return "";
	}
}
