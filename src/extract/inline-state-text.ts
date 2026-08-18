import { decodeEntities } from "./inline-state-scan.ts";

const maxRawTextChars = 16_000;
const maxTailwindTokenChars = 40;

export function cleanInlineText(value: string) {
	return stripHtmlTags(decodeEntities(value.slice(0, maxRawTextChars)))
		.replace(/\s+/g, " ")
		.trim();
}

export function looksLikeTailwind(text: string) {
	const tokens = text.trim().split(/\s+/);
	if (tokens.length < 2) return false;
	let utility = 0;
	let variants = 0;
	for (const token of tokens) {
		const kind = tailwindKind(token);
		if (kind & 1) utility++;
		if (kind & 2) variants++;
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
	return char !== undefined && ("/!?".includes(char) || /[A-Za-z]/.test(char));
}

function tailwindKind(token: string) {
	if (token.length > maxTailwindTokenChars) return 0;
	const value = token.replace(/^[-!]+/, "");
	const parts = splitTailwindToken(value);
	if (parts.length === 0) return 0;
	const variants = parts.slice(0, -1);
	if (!variants.every(isTailwindSegment)) return 0;
	const utility = parts.at(-1)!;
	const utilityLike =
		utility.includes("-") &&
		/^[A-Za-z]/.test(utility) &&
		isTailwindSegment(utility);
	return Number(utilityLike) | (variants.length ? 2 : 0);
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

function isTailwindSegment(token: string) {
	return /^[A-Za-z0-9\-_[\]#./%(),:=]+$/.test(token);
}
