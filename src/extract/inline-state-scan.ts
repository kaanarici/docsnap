import { parseHTML } from "linkedom";

export type ScriptBlock = {
	id: string;
	type: string;
	body: string;
};

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
	for (const match of html.matchAll(/self\.__next_f\.push\(/g)) {
		const argument = balancedExpression(html, match.index + match[0].length);
		if (!argument) continue;
		const parsed = parseJson(argument);
		if (Array.isArray(parsed)) {
			for (const item of parsed) {
				if (typeof item === "string") chunks.push(item);
			}
			continue;
		}
		for (const literal of stringLiterals(argument)) chunks.push(literal);
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
	return balancedExpression(body, match.index + match[0].length);
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

function balancedExpression(input: string, start: number): string | undefined {
	const opening = input[start];
	const closing = opening === "{" ? "}" : opening === "[" ? "]" : undefined;
	if (!closing) return untilSemicolon(input, start);
	let depth = 0;
	let quote = "";
	let escaped = false;
	for (let index = start; index < input.length; index++) {
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
		if (char === closing && --depth === 0) return input.slice(start, index + 1);
	}
	return undefined;
}

function untilSemicolon(input: string, start: number) {
	const end = input.indexOf(";", start);
	return input.slice(start, end === -1 ? input.length : end).trim();
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
