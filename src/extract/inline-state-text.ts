import { decodeEntities } from "./inline-state-scan.ts";

const maxRawTextChars = 16_000;
const maxTailwindTokenChars = 40;

export function cleanInlineText(value: string) {
	const raw =
		value.length > maxRawTextChars ? value.slice(0, maxRawTextChars) : value;
	return stripHtmlTags(decodeEntities(raw)).replace(/\s+/g, " ").trim();
}

export function looksLikeTailwind(text: string) {
	const tokens = text.split(/\s+/).filter(Boolean);
	if (tokens.length < 2) return false;
	let utility = 0;
	let variants = 0;
	for (const token of tokens) {
		const parsed = parseTailwindToken(token);
		if (!parsed) continue;
		if (parsed.utility) utility++;
		if (parsed.variant) variants++;
	}
	return (utility >= 3 && utility / tokens.length > 0.35) || variants >= 3;
}

function stripHtmlTags(value: string) {
	let out = "";
	let inTag = false;
	let pendingSpace = false;
	for (let index = 0; index < value.length; index++) {
		const char = value[index]!;
		if (inTag) {
			if (char === ">") {
				inTag = false;
				pendingSpace = out.length > 0;
			}
			continue;
		}
		if (char === "<" && isTagStart(value[index + 1])) {
			inTag = true;
			continue;
		}
		if (pendingSpace) {
			out += " ";
			pendingSpace = false;
		}
		out += char;
	}
	return out;
}

function isTagStart(char: string | undefined) {
	return (
		char === "/" ||
		char === "!" ||
		char === "?" ||
		(char !== undefined && isAsciiLetter(char))
	);
}

function parseTailwindToken(token: string) {
	if (token.length > maxTailwindTokenChars) return undefined;
	let value = token;
	while (value.startsWith("-") || value.startsWith("!")) value = value.slice(1);
	const parts = splitTailwindToken(value);
	if (parts.length === 0) return undefined;
	const variants = parts.slice(0, -1);
	if (!variants.every(isTailwindSegment)) return undefined;
	return {
		utility: isTailwindUtility(parts.at(-1)!),
		variant: variants.length > 0,
	};
}

function splitTailwindToken(token: string) {
	const parts: string[] = [];
	let start = 0;
	let bracketDepth = 0;
	for (let index = 0; index < token.length; index++) {
		const char = token[index]!;
		if (char === "[") bracketDepth++;
		else if (char === "]") bracketDepth = Math.max(0, bracketDepth - 1);
		else if (char === ":" && bracketDepth === 0) {
			parts.push(token.slice(start, index));
			start = index + 1;
		}
	}
	parts.push(token.slice(start));
	return parts.filter(Boolean);
}

function isTailwindUtility(token: string) {
	return (
		token.includes("-") && isAsciiLetter(token[0]) && isTailwindSegment(token)
	);
}

function isTailwindSegment(token: string) {
	if (!token) return false;
	for (const char of token) {
		if (
			!isAsciiLetter(char) &&
			!isAsciiDigit(char) &&
			!"-_[]#./%(),:=".includes(char)
		) {
			return false;
		}
	}
	return true;
}

function isAsciiLetter(char: string | undefined) {
	if (!char) return false;
	const code = char.charCodeAt(0);
	return (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

function isAsciiDigit(char: string) {
	const code = char.charCodeAt(0);
	return code >= 48 && code <= 57;
}
