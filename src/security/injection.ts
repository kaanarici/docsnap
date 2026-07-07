import { Buffer } from "node:buffer";
import { parseHTML } from "linkedom";
import { markdownLinkHrefs } from "../core/markdown.ts";
import { invisibleTextPattern } from "../core/text.ts";
import type { InjectionSignal } from "../core/types.ts";

type SignalPattern = readonly [InjectionSignal, RegExp];

const invisibleTextTestPattern = new RegExp(invisibleTextPattern, "u");
const invisibleTextGlobalPattern = new RegExp(invisibleTextPattern, "gu");
const maxCommentBlocks = 64;
const maxCommentScanChars = 16 * 1024;
const maxStyleBlocks = 32;
const maxStyleScanChars = 64 * 1024;
const maxStyleRules = 512;
const maxCssDeclarationChars = 16 * 1024;
const rawSkipTags = new Set(["script", "style", "noscript", "template", "svg"]);

const unicodePatterns: SignalPattern[] = [
	["unicode-tag-text", /[\u{e0000}-\u{e007f}]/u],
	["bidi-control", /\p{Bidi_Control}/u],
];

const localSecretTargetPattern = String.raw`(?:~\/\.ssh|\/etc\/passwd|\$[A-Z0-9_]*(?:API_?)?(?:KEY|TOKEN|SECRET)\b|process\.env)`;
const secretTargetPattern = String.raw`(?:${localSecretTargetPattern}|\b(?:api(?:[-_]|[^\S\r\n])?keys?|tokens?|secrets?|environment[^\S\r\n]+variables?|env[^\S\r\n]+vars?|ssh[^\S\r\n]+keys?)\b)`;

const instructionPatterns: SignalPattern[] = [
	[
		"instruction-override",
		/\b(?:ignore|disregard|forget|bypass|override)\b[^\r\n]{0,40}\b(?:previous|prior|above|earlier|system|developer)\b[^\r\n]{0,30}\b(?:instructions?|prompts?|messages?)\b/i,
	],
	[
		"instruction-override",
		/\bi[^\S\r\n]*g[^\S\r\n]*n[^\S\r\n]*o[^\S\r\n]*r[^\S\r\n]*e\b[^\r\n]{0,40}\b(?:previous|prior|above|earlier|system|developer)\b[^\r\n]{0,30}\b(?:instructions?|prompts?|messages?)\b/i,
	],
	[
		"instruction-override",
		/\b(?:do[^\S\r\n]+not|don't)\b[^\r\n]{0,30}\b(?:follow|obey)\b[^\r\n]{0,30}\b(?:system|developer|previous|prior)\b[^\r\n]{0,30}\b(?:instructions?|prompts?)\b/i,
	],
	[
		"ai-directed-instruction",
		/\b(?:ai|assistant|llm|(?:ai|coding|the|this|your)[^\S\r\n]+agent)\b[^\r\n]{0,80}\b(?:ignore|follow|obey|execute|treat|trust|send|reveal|show|print|dump|disclose|expose|leak)\b[^\r\n]{0,80}\b(?:instructions?|prompts?|messages?|guidance|system|developer|this[^\S\r\n]+(?:page|document|content))\b/i,
	],
	[
		"ai-directed-instruction",
		/\b(?:ignore|follow|obey|execute|treat|trust|send|reveal|show|print|dump|disclose|expose|leak)\b[^\r\n]{0,80}\b(?:ai|assistant|llm|(?:ai|coding|the|this|your)[^\S\r\n]+agent)\b/i,
	],
	[
		"tool-exfiltration-language",
		new RegExp(
			String.raw`\bexfiltrate\b[^\r\n]{0,100}${secretTargetPattern}`,
			"i",
		),
	],
	[
		"tool-exfiltration-language",
		new RegExp(
			String.raw`\b(?:send|upload)\b[^\r\n]{0,100}${localSecretTargetPattern}`,
			"i",
		),
	],
	[
		"tool-exfiltration-language",
		new RegExp(
			String.raw`\b(?:post|curl)\b[^\r\n]{0,100}${localSecretTargetPattern}`,
			"i",
		),
	],
	[
		"tool-exfiltration-language",
		new RegExp(
			String.raw`\bread\b[^\r\n]{0,60}${localSecretTargetPattern}`,
			"i",
		),
	],
];

const roleLinePattern =
	/^[^\S\r\n]*(?:system|assistant|developer|tool)[^\S\r\n]*:[^\r\n]{0,300}/gim;
const roleTagPattern =
	/<\/?(?:system|assistant|developer|tool)(?:[^\S\r\n]|>)/gi;
const roleActionPattern =
	/\b(?:ignore|disregard|forget|bypass|override|follow|obey|execute|treat|trust|read|send|exfiltrate|upload|post|curl|reveal|show|print|dump|disclose|expose|leak)\b/i;
const roleTargetPattern = new RegExp(
	String.raw`(?:${secretTargetPattern}|\b(?:previous|prior|above|earlier|system|developer|instructions?|prompts?|messages?|guidance|webhook|operational[^\S\r\n]+guidance|this[^\S\r\n]+(?:page|document|content))\b)`,
	"i",
);

const confusables: Record<string, string> = {
	"\u0391": "A",
	"\u0392": "B",
	"\u0395": "E",
	"\u0396": "Z",
	"\u0397": "H",
	"\u0399": "I",
	"\u039a": "K",
	"\u039c": "M",
	"\u039d": "N",
	"\u039f": "O",
	"\u03a1": "P",
	"\u03a4": "T",
	"\u03a5": "Y",
	"\u03a7": "X",
	"\u03b1": "a",
	"\u03b5": "e",
	"\u03b9": "i",
	"\u03ba": "k",
	"\u03bd": "v",
	"\u03bf": "o",
	"\u03c1": "p",
	"\u03c4": "t",
	"\u03c5": "u",
	"\u03c7": "x",
	"\u0405": "S",
	"\u0406": "I",
	"\u0408": "J",
	"\u0410": "A",
	"\u0412": "B",
	"\u0415": "E",
	"\u041a": "K",
	"\u041c": "M",
	"\u041d": "H",
	"\u041e": "O",
	"\u0420": "P",
	"\u0421": "C",
	"\u0422": "T",
	"\u0423": "Y",
	"\u0425": "X",
	"\u0430": "a",
	"\u0433": "r",
	"\u0435": "e",
	"\u043a": "k",
	"\u043c": "m",
	"\u043e": "o",
	"\u0440": "p",
	"\u0441": "c",
	"\u0442": "t",
	"\u0443": "y",
	"\u0445": "x",
	"\u0455": "s",
	"\u0456": "i",
	"\u0458": "j",
	"\u04bb": "h",
	"\u0501": "d",
	"\u051b": "q",
	"\u051d": "w",
	"\u0570": "h",
	"\u0578": "n",
	"\u057d": "u",
	"\u0585": "o",
};

export function scanRawHtmlForInjectionSignals(
	html: string,
): InjectionSignal[] {
	const signals = new Set<InjectionSignal>();
	for (const signal of htmlCommentSignals(html)) signals.add(signal);
	try {
		const { document } = parseHTML(html);
		const hidden = new Set(hiddenElements(document));
		for (const signal of visibleUnicodeSignals(document, hidden))
			signals.add(signal);
		for (const element of hidden) {
			const phraseSignals = instructionSignals(element.textContent ?? "");
			if (phraseSignals.length === 0) continue;
			signals.add("hidden-html-text");
			for (const signal of phraseSignals) signals.add(signal);
		}
	} catch {
		return [...signals];
	}
	return [...signals];
}

function visibleUnicodeSignals(
	document: Document,
	hidden: Set<Element>,
): InjectionSignal[] {
	const signals = new Set<InjectionSignal>();
	const stack: Node[] = [document.body ?? document.documentElement];
	while (stack.length > 0) {
		const node = stack.pop();
		if (!node) continue;
		if (node.nodeType === 3) {
			if (hasVisibleText(node.textContent ?? "")) {
				for (const signal of unicodeSignals(node.textContent ?? ""))
					signals.add(signal);
			}
			continue;
		}
		if (node.nodeType !== 1) continue;
		const element = node as Element;
		if (hidden.has(element) || rawSkipTags.has(element.tagName.toLowerCase()))
			continue;
		const children = element.childNodes;
		for (let index = children.length - 1; index >= 0; index--) {
			const child = children[index];
			if (child) stack.push(child);
		}
	}
	return [...signals];
}

function hasVisibleText(text: string) {
	return /\p{L}|\p{N}/u.test(stripInvisibleText(text));
}

export function scanMarkdownForInjectionSignals(
	markdown: string,
): InjectionSignal[] {
	return unique([
		...unicodeSignals(markdown),
		...instructionSignals(markdown),
		...mixedScriptSignals(markdown),
		...unsafeLinkSchemeSignals(markdown),
		...encodedSignals(markdown),
	]);
}

function unicodeSignals(text: string): InjectionSignal[] {
	return unique([
		...unicodePatterns
			.filter(([, pattern]) => pattern.test(text))
			.map(([signal]) => signal),
		...zeroWidthSignals(text),
	]);
}

function instructionSignals(text: string): InjectionSignal[] {
	const direct = directInstructionSignals(text);
	const stripped = stripInvisibleText(text);
	return stripped === text
		? direct
		: unique([...direct, ...directInstructionSignals(stripped)]);
}

function directInstructionSignals(text: string): InjectionSignal[] {
	const signals = new Set<InjectionSignal>(
		instructionPatterns
			.filter(([, pattern]) => pattern.test(text))
			.map(([signal]) => signal),
	);
	if (hasFakeRoleTurn(text)) signals.add("fake-system-turn");
	return [...signals];
}

function zeroWidthSignals(text: string): InjectionSignal[] {
	if (!invisibleTextTestPattern.test(text)) return [];
	const direct = new Set(directInstructionSignals(text));
	const revealed = directInstructionSignals(stripInvisibleText(text)).filter(
		(signal) => !direct.has(signal),
	);
	return revealed.length ? unique(["zero-width-text", ...revealed]) : [];
}

function stripInvisibleText(text: string) {
	return text.replace(invisibleTextGlobalPattern, "");
}

function mixedScriptSignals(text: string): InjectionSignal[] {
	const normalized = normalizeConfusables(text.normalize("NFKC"));
	if (normalized === text) return [];
	const signals = instructionSignals(normalized);
	return signals.length ? unique(["mixed-script-confusable", ...signals]) : [];
}

function normalizeConfusables(text: string) {
	let changed = false;
	const normalized = Array.from(text, (char) => {
		const replacement = confusables[char];
		if (replacement === undefined) return char;
		changed = true;
		return replacement;
	}).join("");
	return changed ? normalized : text;
}

function encodedSignals(text: string): InjectionSignal[] {
	const signals = new Set<InjectionSignal>();
	for (const candidate of encodedCandidates(text)) {
		const decoded = decodeCandidate(candidate);
		if (decoded && instructionSignals(decoded).length > 0) {
			signals.add("encoded-injection-blob");
			continue;
		}
		if (isOpaqueEncodedBlob(candidate)) signals.add("opaque-encoded-blob");
	}
	return [...signals];
}

function isOpaqueEncodedBlob(candidate: string) {
	return (
		candidate.length >= 128 &&
		!candidate.includes("/") &&
		!/^[0-9a-fA-F]+$/.test(candidate) &&
		!/^[a-z0-9]+(?:-[a-z0-9]+){2,}$/.test(candidate)
	);
}

function unsafeLinkSchemeSignals(markdown: string): InjectionSignal[] {
	for (const href of markdownLinkHrefs(markdown)) {
		const scheme = hrefScheme(href);
		if (scheme === "javascript" || scheme === "vbscript") {
			return ["unsafe-link-scheme"];
		}
	}
	return [];
}

function hrefScheme(href: string) {
	const trimmed = normalizeSchemePrefix(trimLeadingSpacesAndControls(href));
	const colon = trimmed.indexOf(":");
	if (colon <= 0) return undefined;
	return trimmed.slice(0, colon).toLowerCase();
}

function normalizeSchemePrefix(value: string) {
	const prefix = value.slice(0, 64);
	return decodeHtmlCharRefs(decodePercentBytes(prefix)) + value.slice(64);
}

function decodeHtmlCharRefs(value: string) {
	return value.replace(
		/&#(?:x([0-9a-f]{1,6})|([0-9]{1,7}));?/gi,
		(_match, hex: string | undefined, decimal: string | undefined) => {
			const codePoint = Number.parseInt(hex ?? decimal ?? "", hex ? 16 : 10);
			if (!Number.isFinite(codePoint) || codePoint > 0x10ffff) return "";
			try {
				return String.fromCodePoint(codePoint);
			} catch {
				return "";
			}
		},
	);
}

function decodePercentBytes(value: string) {
	return value.replace(/%([0-9a-f]{2})/gi, (_match, hex: string) =>
		String.fromCharCode(Number.parseInt(hex, 16)),
	);
}

function trimLeadingSpacesAndControls(value: string) {
	let index = 0;
	while (index < value.length) {
		const code = value.charCodeAt(index);
		if (code > 0x20 && (code < 0x7f || code > 0x9f)) break;
		index++;
	}
	return value.slice(index);
}

function encodedCandidates(text: string) {
	const candidates = new Set<string>();
	for (const match of text.matchAll(/\b[A-Za-z0-9+/_-]{32,}={0,2}\b/g)) {
		candidates.add(match[0]);
	}
	for (const match of text.matchAll(/\b[0-9a-fA-F]{64,}\b/g)) {
		candidates.add(match[0]);
	}
	return candidates;
}

function htmlCommentSignals(html: string): InjectionSignal[] {
	const signals = new Set<InjectionSignal>();
	let position = 0;
	for (let count = 0; count < maxCommentBlocks; count++) {
		const start = html.indexOf("<!--", position);
		if (start < 0) break;
		const contentStart = start + 4;
		const end = html.indexOf("-->", contentStart);
		const scanEnd = Math.min(
			end < 0 ? html.length : end,
			contentStart + maxCommentScanChars,
		);
		const commentSignals = instructionSignals(
			html.slice(contentStart, scanEnd),
		);
		if (commentSignals.length > 0) {
			signals.add("html-comment-instruction");
			for (const signal of commentSignals) signals.add(signal);
		}
		if (end < 0) break;
		position = end + 3;
	}
	return [...signals];
}

function hasFakeRoleTurn(text: string) {
	for (const match of text.matchAll(roleLinePattern)) {
		if (hasRoleInstruction(match[0] ?? "")) return true;
	}
	for (const match of text.matchAll(roleTagPattern)) {
		if (hasRoleInstruction(roleTagContext(text, match.index ?? 0))) return true;
	}
	return false;
}

function roleTagContext(text: string, index: number) {
	return text.slice(
		Math.max(0, index - 240),
		Math.min(text.length, index + 512),
	);
}

function hasRoleInstruction(text: string) {
	return roleActionPattern.test(text) && roleTargetPattern.test(text);
}

function decodeCandidate(candidate: string): string | undefined {
	if (/^[0-9a-fA-F]+$/.test(candidate) && candidate.length % 2 === 0) {
		return decodedTextIfReadable(
			Buffer.from(candidate, "hex").toString("utf8"),
		);
	}
	const normalized = candidate.replace(/-/g, "+").replace(/_/g, "/");
	const base64 = decodeBase64(normalized);
	if (base64) return base64;
	return undefined;
}

function decodeBase64(candidate: string): string | undefined {
	if (candidate.length % 4 === 1) return undefined;
	const padded = candidate.padEnd(Math.ceil(candidate.length / 4) * 4, "=");
	if (!/^[A-Za-z0-9+/]+={0,2}$/.test(padded)) return undefined;
	return decodedTextIfReadable(Buffer.from(padded, "base64").toString("utf8"));
}

function decodedTextIfReadable(text: string) {
	const compact = text.replace(/\s/g, "");
	if (!compact) return undefined;
	const printableCount = Array.from(compact).filter((char) => {
		const code = char.codePointAt(0) ?? 0;
		return code >= 0x20 && code !== 0x7f;
	}).length;
	return printableCount / compact.length >= 0.75 ? text : undefined;
}

function hiddenElements(document: Document): Element[] {
	const out = new Set<Element>();
	for (const element of document.querySelectorAll("*")) {
		if (isInlineHidden(element)) out.add(element);
	}
	for (const selector of hiddenStyleSelectors(document)) {
		try {
			for (const element of document.querySelectorAll(selector))
				out.add(element);
		} catch {}
	}
	return [...out];
}

function isInlineHidden(element: Element) {
	return (
		element.hasAttribute("hidden") ||
		element.getAttribute("aria-hidden")?.toLowerCase() === "true" ||
		hidesText(element.getAttribute("style") ?? "")
	);
}

function hiddenStyleSelectors(document: Document) {
	const selectors: string[] = [];
	let styleCount = 0;
	for (const style of document.querySelectorAll("style")) {
		if (styleCount++ >= maxStyleBlocks) break;
		selectors.push(...hiddenSelectorsFromCss(style.textContent ?? ""));
	}
	return selectors;
}

function hidesText(style: string) {
	const text = style.slice(0, maxCssDeclarationChars).toLowerCase();
	return (
		/display[^\S\r\n]*:[^\S\r\n]*none\b/.test(text) ||
		/visibility[^\S\r\n]*:[^\S\r\n]*hidden\b/.test(text) ||
		/opacity[^\S\r\n]*:[^\S\r\n]*0(?:\.0+)?(?:\b|;|!)/.test(text) ||
		/font-size[^\S\r\n]*:[^\S\r\n]*0(?:\b|;|!)/.test(text) ||
		/clip(?:-path)?[^\S\r\n]*:/.test(text) ||
		/content-visibility[^\S\r\n]*:[^\S\r\n]*hidden\b/.test(text) ||
		/(?:left|right|top|bottom|margin-left|text-indent)[^\S\r\n]*:[^\S\r\n]*-\d{3,}(?:px|em|rem)?/.test(
			text,
		) ||
		/transform[^\S\r\n]*:[^;]*(?:translate(?:x|y|3d)?\([^)]*-\d{3,}(?:px|em|rem|vw|vh)|scale(?:x|y)?\([^\S\r\n]*0(?:\.0+)?[^\S\r\n]*\))/.test(
			text,
		) ||
		/color[^\S\r\n]*:[^\S\r\n]*transparent\b/.test(text) ||
		(whiteColorText.test(text) && whiteColorBackground.test(text))
	);
}

function hiddenSelectorsFromCss(css: string) {
	const selectors: string[] = [];
	const text = css.slice(0, maxStyleScanChars);
	let position = 0;
	for (let count = 0; count < maxStyleRules; count++) {
		const open = text.indexOf("{", position);
		if (open < 0) break;
		const close = text.indexOf("}", open + 1);
		if (close < 0) break;
		if (hidesText(text.slice(open + 1, close))) {
			for (const selector of text.slice(position, open).split(",")) {
				const clean = selector.trim();
				if (clean && !clean.startsWith("@")) selectors.push(clean);
			}
		}
		position = close + 1;
	}
	return selectors;
}

function whiteColorPattern(property: string) {
	const gap = "[^\\S\\r\\n]*";
	const white = `(?:#fff(?:fff)?|white|rgb\\(${gap}255${gap},${gap}255${gap},${gap}255${gap}\\))`;
	return new RegExp(`${property}${gap}:${gap}${white}\\b`);
}

// Compiled once: hidesText runs per styled element, so building these per call
// recompiled two regexes on every element of every page.
const whiteColorText = whiteColorPattern("color");
const whiteColorBackground = whiteColorPattern("background(?:-color)?");

function unique<T>(values: T[]): T[] {
	return [...new Set(values)];
}
