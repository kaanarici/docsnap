import { parseHTML } from "linkedom";

export type ScriptBlock = {
	id: string;
	type: string;
	body: string;
};

const nextFlightPush = "self.__next_f.push(";
const maxNextFlightScanBytes = 4 * 1024 * 1024;
const maxNextFlightChunks = 4_096;

export function scriptBlocks(html: string): ScriptBlock[] {
	const { document } = parseHTML(html);
	return Array.from(document.querySelectorAll("script")).map((script) => ({
		id: script.getAttribute("id") ?? "",
		type: script.getAttribute("type") ?? "",
		body: script.textContent ?? "",
	}));
}

export function htmlTitle(html: string) {
	const { document } = parseHTML(html);
	return (
		document.querySelector("h1")?.textContent?.trim() ||
		document.querySelector("title")?.textContent?.trim() ||
		document
			.querySelector('meta[property="og:title"],meta[name="twitter:title"]')
			?.getAttribute("content")
			?.trim() ||
		undefined
	);
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
		scanned += Math.max(0, argument.end - start);
		cursor = Math.max(argument.end, start + 1);
		chunkCount++;
		if (!argument.value) continue;
		const parsed = parseJson(argument.value);
		if (Array.isArray(parsed)) {
			for (const item of parsed) {
				if (typeof item === "string") chunks.push(item);
			}
			continue;
		}
		for (const literal of stringLiterals(argument.value)) chunks.push(literal);
	}
	return chunks;
}

export function assignedExpression(body: string, name: string) {
	const pattern = new RegExp(
		`(?:window\\.)?${escapeRegex(name)}\\s*=\\s*`,
		"g",
	);
	const match = pattern.exec(body);
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

export function parseJson(value: string): unknown {
	try {
		return JSON.parse(value.trim());
	} catch {
		return undefined;
	}
}

export function stringLiterals(input: string): string[] {
	const out: string[] = [];
	for (const match of input.matchAll(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g)) {
		const decoded = decodeStringLiteral(match[0]);
		if (decoded) out.push(decoded);
	}
	return out;
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
	return value
		.replace(/&nbsp;/g, " ")
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'");
}

type BalancedExpression = {
	value?: string;
	end: number;
};

function balancedExpression(
	input: string,
	start: number,
	maxEnd = input.length,
): BalancedExpression {
	const limit = Math.min(input.length, Math.max(start, maxEnd));
	const opening = input[start];
	const closing = opening === "{" ? "}" : opening === "[" ? "]" : undefined;
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
		if (char === '"' || char === "'") {
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
		if (literal.startsWith('"')) return JSON.parse(literal);
		const body = literal.slice(1, -1).replace(/\\'/g, "'");
		return JSON.parse(`"${body.replace(/"/g, '\\"')}"`);
	} catch {
		return "";
	}
}

function escapeRegex(value: string) {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
