export const elementNode = 1;
export const textNode = 3;
export const maxRootFrames = 60_000;
export const maxSerializeVisits = 60_000;
export const maxOutputChars = 200_000;
export const maxInlineChars = 16_000;
export const maxCodeChars = 40_000;
export const maxTableRows = 240;
export const maxTableCells = 2_000;
export const maxTableFrames = 12_000;
export const maxListItems = 500;
export const maxDirectChildScan = 2_000;
export const maxListDepth = 6;
export const maxLanguageChars = 32;

export type TextStats = {
	textChars: number;
	anchorChars: number;
};

export type VisitBudget = {
	visits: number;
	maxVisits: number;
};

export type OutputState = {
	chars: number;
};

export const emptyStats = (): TextStats => ({ textChars: 0, anchorChars: 0 });
export const linkDensity = (stats: TextStats) =>
	stats.textChars === 0 ? 1 : stats.anchorChars / stats.textChars;

export function takeVisit(budget: VisitBudget) {
	if (budget.visits >= budget.maxVisits) return false;
	budget.visits++;
	return true;
}

export function tagName(element: Element | undefined) {
	return element?.tagName.toLowerCase() ?? "";
}

export function isElement(node: Node | undefined | null): node is Element {
	return node?.nodeType === elementNode;
}

export function isPreferredRoot(element: Element) {
	const tag = tagName(element);
	return tag === "main" || tag === "article" || role(element) === "main";
}

export function isCandidateRoot(element: Element) {
	return rootCandidateTags.has(tagName(element));
}

export function isHeading(tag: string) {
	return tag.length === 2 && tag[0] === "h" && tag[1]! >= "1" && tag[1]! <= "6";
}

export function shouldSkipElement(element: Element) {
	const tag = tagName(element);
	return (
		skipTags.has(tag) || isChromeElement(element) || isHiddenElement(element)
	);
}

function isChromeElement(element: Element) {
	const tag = tagName(element);
	return chromeTags.has(tag) || role(element) === "navigation";
}

const role = (element: Element) => element.getAttribute("role")?.toLowerCase();

function isHiddenElement(element: Element) {
	return (
		element.hasAttribute("hidden") ||
		element.getAttribute("aria-hidden")?.toLowerCase() === "true" ||
		styleHidesElement(element.getAttribute("style") ?? "")
	);
}

export function isLinkDominatedContainer(element: Element) {
	const tag = tagName(element);
	if (tag !== "article" && tag !== "section" && tag !== "div") return false;
	if (hasDirectHeading(element)) return false;
	const stats = quickTextStats(element);
	return stats.textChars >= 20 && linkDensity(stats) > 0.5;
}

function hasDirectHeading(element: Element) {
	const children = element.childNodes;
	for (
		let index = 0;
		index < children.length && index < maxDirectChildScan;
		index++
	) {
		const child = children[index];
		if (isElement(child) && isHeading(tagName(child))) return true;
	}
	return false;
}

function quickTextStats(root: Element): TextStats {
	const stats = emptyStats();
	const stack: Array<{ node: Node; inAnchor: boolean }> = [
		{ node: root, inAnchor: false },
	];
	let visits = 0;
	while (stack.length > 0 && visits++ < 2_000) {
		const frame = stack.pop()!;
		if (frame.node.nodeType === textNode) {
			const chars = countTextChars(frame.node.textContent ?? "");
			stats.textChars += chars;
			if (frame.inAnchor) stats.anchorChars += chars;
			continue;
		}
		if (!isElement(frame.node) || shouldSkipElement(frame.node)) continue;
		const inAnchor = frame.inAnchor || tagName(frame.node) === "a";
		const children = frame.node.childNodes;
		const remaining = Math.max(0, 2_000 - visits);
		let pushed = 0;
		for (let index = children.length - 1; index >= 0; index--) {
			if (pushed >= remaining) break;
			const child = children[index];
			if (!child) continue;
			stack.push({ node: child, inAnchor });
			pushed++;
		}
	}
	return stats;
}

function styleHidesElement(style: string) {
	for (const declaration of style.slice(0, 2_048).split(";")) {
		const colon = declaration.indexOf(":");
		if (colon < 0) continue;
		const property = declaration.slice(0, colon).trim().toLowerCase();
		const value = declaration
			.slice(colon + 1)
			.trim()
			.toLowerCase();
		if (property === "display" && value.startsWith("none")) return true;
		if (property === "visibility" && value.startsWith("hidden")) return true;
	}
	return false;
}

const rootCandidateTags = wordSet("article main section div table td");
export const allowedSchemes = wordSet("http: https: mailto:");
const chromeTags = wordSet("nav header footer aside");
const skipTags = wordSet("script style noscript template svg canvas");
export const voidTags = wordSet(
	"area base col embed iframe img input link meta param source track wbr",
);
export const blockTags = wordSet(
	"address article aside blockquote details dialog div dl fieldset figcaption figure footer form h1 h2 h3 h4 h5 h6 header hr li main nav ol p pre section table ul",
);
export const tableBlockTags = wordSet(
	"article blockquote div h1 h2 h3 h4 h5 h6 li ol p pre section table ul",
);
export const languageExtraChars = new Set("_#+.-");
export const unsafeHrefChars = new Set(')<>"');
const whitespaceChars = new Set([" ", "\n", "\r", "\t", "\f"]);

function wordSet(values: string) {
	return new Set(values.split(" "));
}

export function countTextChars(value: string) {
	let count = 0;
	for (const char of value) {
		if (!isWhitespace(char)) count++;
	}
	return count;
}

export function collapseWhitespace(value: string) {
	const out: string[] = [];
	let pendingSpace = false;
	for (const char of value) {
		if (isWhitespace(char)) {
			pendingSpace = out.length > 0;
			continue;
		}
		if (pendingSpace) out.push(" ");
		out.push(char);
		pendingSpace = false;
	}
	return out.join("");
}

export function collapseInlineWhitespace(value: string) {
	const collapsed = collapseWhitespace(value);
	if (!collapsed) return value ? " " : "";
	const prefix = isWhitespace(value[0] ?? "") ? " " : "";
	const suffix = isWhitespace(value[value.length - 1] ?? "") ? " " : "";
	return `${prefix}${collapsed}${suffix}`;
}

export function tidyInline(value: string) {
	const out: string[] = [];
	let pendingSpace = false;
	let pendingNewline = false;
	for (const char of value) {
		if (char === "\n") {
			pendingNewline = out.length > 0;
			pendingSpace = false;
			continue;
		}
		if (isWhitespace(char)) {
			pendingSpace = out.length > 0;
			continue;
		}
		if (pendingNewline) out.push("\n");
		else if (pendingSpace) out.push(" ");
		out.push(char);
		pendingSpace = false;
		pendingNewline = false;
	}
	return out.join("").trim();
}

export function sanitizeText(value: string) {
	const out: string[] = [];
	for (const char of value) {
		const code = char.codePointAt(0) ?? 0;
		if ((code < 0x20 && char !== "\n" && char !== "\t") || code === 0x7f) {
			continue;
		}
		if (char === "<") out.push("&lt;");
		else if (char === ">") out.push("&gt;");
		else out.push(char);
	}
	return out.join("");
}

export function linkText(value: string) {
	const out: string[] = [];
	let pendingSpace = false;
	for (const char of value) {
		if (isWhitespace(char)) {
			pendingSpace = out.length > 0;
			continue;
		}
		if (pendingSpace) out.push(" ");
		if (char === "[" || char === "]" || char === "`") out.push("\\", char);
		else if (char === "<") out.push("&lt;");
		else if (char === ">") out.push("&gt;");
		else out.push(char);
		pendingSpace = false;
	}
	return out.join("").trim();
}

export function stripControlChars(value: string) {
	const out: string[] = [];
	for (const char of value) {
		const code = char.codePointAt(0) ?? 0;
		if (code >= 0x20 && (code < 0x7f || code > 0x9f)) out.push(char);
	}
	return out.join("");
}

export function hasUnsafeHrefChar(value: string) {
	for (const char of value) {
		const code = char.codePointAt(0) ?? 0;
		if (
			unsafeHrefChars.has(char) ||
			isWhitespace(char) ||
			code < 0x20 ||
			code === 0x7f
		) {
			return true;
		}
	}
	return false;
}

export function escapeTableCell(value: string) {
	const out: string[] = [];
	for (const char of value) {
		if (char === "|") out.push("\\|");
		else out.push(char);
	}
	return out.join("");
}

export function removePipes(value: string) {
	const out: string[] = [];
	for (const char of value.replaceAll("\n", " ")) {
		if (char !== "|") out.push(char);
	}
	return out.join("");
}

export function pushInline(chunks: string[], value: string, chars: number) {
	if (!value || chars >= maxInlineChars) return chars;
	const available = maxInlineChars - chars;
	const chunk = value.length > available ? value.slice(0, available) : value;
	chunks.push(chunk);
	return chars + chunk.length;
}

export function maxBacktickRun(value: string) {
	let max = 0;
	let run = 0;
	for (const char of value) {
		if (char === "`") {
			run++;
			if (run > max) max = run;
		} else {
			run = 0;
		}
	}
	return max;
}

export function isLanguageChar(char: string) {
	return (
		(char >= "A" && char <= "Z") ||
		(char >= "a" && char <= "z") ||
		(char >= "0" && char <= "9") ||
		languageExtraChars.has(char)
	);
}

export function isWhitespace(char: string) {
	return whitespaceChars.has(char);
}
