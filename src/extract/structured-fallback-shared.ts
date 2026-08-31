import { safeMarkdownDestination } from "../core/markdown.ts";

const elementNode = 1;
export const textNode = 3;
export const maxSerializeVisits = 60_000;
export const maxOutputChars = 480_000;
export const maxInlineChars = 16_000;
export const maxCodeChars = 40_000;
export const maxTableRows = 240;
export const maxTableCells = 2_000;
export const maxTableFrames = 12_000;
export const maxListItems = 500;
export const maxDirectChildScan = 2_000;
export const maxListDepth = 6;

export type VisitBudget = {
	visits: number;
	maxVisits: number;
	truncated?: boolean;
};

export function takeVisit(budget: VisitBudget) {
	if (budget.visits >= budget.maxVisits) {
		budget.truncated = true;
		return false;
	}
	budget.visits++;
	return true;
}

export function tagName(element: Element | undefined) {
	return element?.tagName.toLowerCase() ?? "";
}

export function isElement(node: Node | undefined | null): node is Element {
	return node?.nodeType === elementNode;
}

export function isHeading(tag: string) {
	return tag.length === 2 && tag[0] === "h" && tag[1]! >= "1" && tag[1]! <= "6";
}

export function actsLikeBlock(element: Element) {
	return (
		blockTags.has(tagName(element)) || element.getAttribute("data-as") === "p"
	);
}

export function shouldSkipElement(element: Element) {
	const tag = tagName(element);
	return (
		skipTags.has(tag) ||
		isChromeElement(element, tag) ||
		isShareChrome(element, tag) ||
		isSubscriptionChrome(element, tag) ||
		isHiddenElement(element)
	);
}

function isChromeElement(element: Element, tag: string) {
	const elementRole = element.getAttribute("role")?.toLowerCase();
	return (
		chromeTags.has(tag) ||
		Boolean(elementRole && chromeRoles.has(elementRole)) ||
		isCodeCopyControl(element, tag) ||
		((tag === "button" || tag === "a" || elementRole === "button") &&
			controlChromePattern.test(
				boundedElementText(element, 160, 80).toLowerCase(),
			))
	);
}

function isCodeCopyControl(element: Element, tag: string) {
	if (tag !== "button") return false;
	const label = collapseWhitespace(
		`${element.getAttribute("aria-label") ?? ""} ${element.getAttribute("title") ?? ""}`,
	).toLowerCase();
	const className = element.getAttribute("class")?.toLowerCase() ?? "";
	return (
		/^(?:copy|copy the) code$/.test(label) ||
		/(?:code-copy|copy-code|muicode-copy)/.test(className)
	);
}

function isShareChrome(element: Element, tag: string) {
	if (!shareCandidateTags.has(tag)) return false;
	if (!widgetHint(element, "share") && !widgetHint(element, "social")) {
		return false;
	}
	const text = boundedElementText(element, 120, 120).toLowerCase();
	if (!/^(?:share|share this):?$/.test(text)) return false;
	return (
		hasElementMatching(element, 120, (candidate) =>
			interactiveTags.has(tagName(candidate)),
		) &&
		!hasElementMatching(element, 120, (candidate) =>
			contentBlockTags.has(tagName(candidate)),
		)
	);
}

function isSubscriptionChrome(element: Element, tag: string) {
	if (!subscriptionCandidateTags.has(tag)) return false;
	if (
		tag !== "form" &&
		!widgetHint(element, "newsletter") &&
		!widgetHint(element, "subscribe") &&
		!widgetHint(element, "signup")
	) {
		return false;
	}
	const text = boundedElementText(element, 1_200, 240).toLowerCase();
	if (!/\b(?:newsletter|subscribe|sign up|email updates)\b/.test(text)) {
		return false;
	}
	if (
		!/\b(?:email address|your email|privacy|personalized communications)\b/.test(
			text,
		)
	) {
		return false;
	}
	return hasElementMatching(element, 240, (candidate) => {
		if (tagName(candidate) !== "input") return false;
		return (
			attrEquals(candidate, "type", "email") ||
			attrIncludes(candidate, "name", "email") ||
			attrEquals(candidate, "autocomplete", "email") ||
			attrIncludes(candidate, "placeholder", "email")
		);
	});
}

function widgetHint(element: Element, needle: string) {
	return (
		attrIncludes(element, "class", needle) ||
		attrIncludes(element, "id", needle) ||
		attrIncludes(element, "aria-label", needle)
	);
}

function boundedElementText(
	element: Element,
	maxChars: number,
	maxVisits: number,
) {
	const chunks: string[] = [];
	let chars = 0;
	let visits = 0;
	const stack: Node[] = [element];
	while (stack.length > 0 && chars < maxChars && visits++ < maxVisits) {
		const node = stack.pop()!;
		if (node.nodeType === textNode) {
			const text = node.textContent ?? "";
			const chunk = text.slice(0, maxChars - chars);
			chunks.push(chunk);
			chars += chunk.length;
			continue;
		}
		if (!isElement(node) || skipTags.has(tagName(node))) continue;
		pushNodeChildren(stack, node, maxVisits - visits);
	}
	return collapseWhitespace(chunks.join(""));
}

function hasElementMatching(
	element: Element,
	maxVisits: number,
	match: (element: Element) => boolean,
) {
	let visits = 0;
	const stack: Node[] = [element];
	while (stack.length > 0 && visits++ < maxVisits) {
		const node = stack.pop()!;
		if (!isElement(node) || skipTags.has(tagName(node))) continue;
		if (node !== element && match(node)) return true;
		pushNodeChildren(stack, node, maxVisits - visits);
	}
	return false;
}

export function pushNodeChildren(
	stack: Node[],
	element: Element,
	limit: number,
) {
	let pushed = 0;
	for (
		let index = element.childNodes.length - 1;
		index >= 0 && pushed < limit;
		index--
	) {
		const child = element.childNodes[index];
		if (!child) continue;
		stack.push(child);
		pushed++;
	}
}

function attrEquals(element: Element, name: string, value: string) {
	return element.getAttribute(name)?.toLowerCase() === value;
}

function attrIncludes(element: Element, name: string, value: string) {
	return element.getAttribute(name)?.toLowerCase().includes(value) ?? false;
}

export function isHiddenElement(element: Element) {
	return (
		element.hasAttribute("hidden") ||
		element.getAttribute("aria-hidden")?.toLowerCase() === "true" ||
		/(?:^|\s)(?:hidden|sr-only|visually-hidden)(?:\s|$)/.test(
			element.getAttribute("class") ?? "",
		) ||
		/(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*hidden)/i.test(
			(element.getAttribute("style") ?? "").slice(0, 2_048),
		)
	);
}

export function isLinkDominatedContainer(element: Element) {
	const tag = tagName(element);
	if (tag !== "article" && tag !== "section" && tag !== "div") return false;
	if (hasNearbyHeading(element)) return false;
	const previous = element.previousElementSibling;
	if (
		previous &&
		tagName(previous) === "p" &&
		countTextChars(boundedElementText(previous, 160, 80)) >= 40
	)
		return false;
	const { textChars, anchorChars } = walkText(element, { maxVisits: 2_000 });
	if (textChars < 20 || anchorChars / textChars <= 0.7) return false;
	return !(
		textChars >= 120 && /[.!?]/.test(boundedElementText(element, 512, 400))
	);
}

function hasNearbyHeading(element: Element) {
	return containsHeading(element, 0, { visits: 0, maxVisits: 240 });
}

function containsHeading(
	node: Node,
	depth: number,
	budget: VisitBudget,
): boolean {
	if (!takeVisit(budget) || !isElement(node)) return false;
	if (depth > 0 && isHeading(tagName(node))) return true;
	if (depth >= 3 || shouldSkipElement(node)) return false;
	for (const child of node.childNodes) {
		if (containsHeading(child, depth + 1, budget)) return true;
		if (budget.visits >= budget.maxVisits) break;
	}
	return false;
}

export function walkText(
	root: Node,
	options: { maxVisits: number; collectChars?: number },
): {
	parts: string[];
	textChars: number;
	anchorChars: number;
	truncated: boolean;
} {
	const collect = options.collectChars ?? 0;
	const parts: string[] = [];
	let textChars = 0;
	let anchorChars = 0;
	let outputChars = 0;
	let clipped = false;
	let visits = 0;
	const stack: Array<{ node: Node; inAnchor: boolean }> = [
		{ node: root, inAnchor: false },
	];
	while (
		stack.length > 0 &&
		visits++ < options.maxVisits &&
		(collect === 0 || outputChars < collect)
	) {
		const frame = stack.pop()!;
		if (frame.node.nodeType === textNode) {
			const raw = frame.node.textContent ?? "";
			const value = collect ? raw.slice(0, collect - outputChars) : raw;
			if (collect) {
				clipped ||= value.length < raw.length;
				parts.push(value);
				outputChars += value.length;
			}
			const chars = countTextChars(value);
			textChars += chars;
			if (frame.inAnchor) anchorChars += chars;
			continue;
		}
		if (!isElement(frame.node) || shouldSkipElement(frame.node)) continue;
		const inAnchor = frame.inAnchor || tagName(frame.node) === "a";
		pushAnchorFrames(stack, frame.node, options.maxVisits - visits, inAnchor);
	}
	return {
		parts,
		textChars,
		anchorChars,
		truncated: clipped || visits >= options.maxVisits || stack.length > 0,
	};
}

function pushAnchorFrames(
	stack: Array<{ node: Node; inAnchor: boolean }>,
	element: Element,
	limit: number,
	inAnchor: boolean,
) {
	const children = element.childNodes;
	let pushed = 0;
	for (
		let index = children.length - 1;
		index >= 0 && pushed < Math.max(0, limit);
		index--
	) {
		const child = children[index];
		if (!child) continue;
		stack.push({ node: child, inAnchor });
		pushed++;
	}
}

const allowedSchemes = wordSet("http: https: mailto:");
const chromeTags = wordSet("nav header footer aside");
const chromeRoles = wordSet("navigation tab tablist");
const contentBlockTags = wordSet("code h1 h2 h3 h4 h5 h6 p pre table");
const interactiveTags = wordSet("a button input select textarea");
const shareCandidateTags = wordSet("div section ul ol");
const subscriptionCandidateTags = wordSet("div section form");
const skipTags = wordSet("script style noscript template svg canvas");
export const voidTags = wordSet(
	"area base col embed iframe img input link meta param source track wbr",
);
const blockTags = wordSet(
	"address article aside blockquote details dialog div dl fieldset figcaption figure footer form h1 h2 h3 h4 h5 h6 header hr li main nav ol p pre section table ul",
);
export const tableBlockTags = wordSet(
	"article blockquote div h1 h2 h3 h4 h5 h6 li ol p pre section table ul",
);
const whitespacePattern = /[ \n\r\t\f]/;
const whitespaceRunPattern = /[ \n\r\t\f]+/g;
const inlineJoinEndPattern = /[\p{L}\p{N}`!?:;)]$/u;
const inlineJoinStartPattern = /^[\p{L}`]/u;
const rawPattern = (source: string, flags?: string) =>
	new RegExp(source, flags);
const sanitizeControlPattern = rawPattern(
	String.raw`[\x00-\x08\x0B-\x1F\x7F]`,
	"g",
);
const stripControlPattern = rawPattern(String.raw`[\x00-\x1F\x7F-\x9F]`, "g");
const unsafeHrefPattern = rawPattern(String.raw`[<>" \n\r\t\f\x00-\x1F\x7F]`);
const fencedBlockPattern = /(`{3,})[^\n]*\n[\s\S]*?\n\1/g;

function wordSet(values: string) {
	return new Set(values.split(" "));
}

export function countTextChars(value: string) {
	return value.replace(whitespaceRunPattern, "").length;
}

export function collapseWhitespace(value: string) {
	return value.replace(whitespaceRunPattern, " ").trim();
}

export function collapseInlineWhitespace(value: string) {
	const collapsed = collapseWhitespace(value);
	if (!collapsed) return value ? " " : "";
	const prefix = whitespacePattern.test(value[0] ?? "") ? " " : "";
	return `${prefix}${collapsed}${whitespacePattern.test(value[value.length - 1] ?? "") ? " " : ""}`;
}

export function tidyInline(value: string) {
	const blocks: string[] = [];
	return value
		.replace(fencedBlockPattern, (block) => `@@F${blocks.push(block) - 1}@@`)
		.replace(/[ \r\t\f]+/g, " ")
		.replace(/ *\n+ */g, "\n")
		.replace(/ +([,.;:!?)](?:\s|$))/g, "$1")
		.replace(/@@F(\d+)@@/g, (_match, index) => blocks[Number(index)] ?? "")
		.trim();
}

export function sanitizeText(value: string) {
	return value
		.replace(sanitizeControlPattern, "")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;");
}

export function linkText(value: string) {
	return collapseWhitespace(value)
		.replace(/[[\]`]/g, "\\$&")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;");
}

export function safeHref(value: string | null, baseUrl: string) {
	if (!value) return undefined;
	const stripped = value.trim().replace(stripControlPattern, "");
	if (!stripped || unsafeHrefPattern.test(stripped)) return undefined;
	try {
		const resolved = new URL(stripped, baseUrl);
		if (!allowedSchemes.has(resolved.protocol)) return undefined;
		return safeMarkdownDestination(
			stripped.startsWith("//") ? resolved.href : stripped,
		);
	} catch {
		return undefined;
	}
}

export function imageMarkdown(element: Element, baseUrl: string) {
	const src = imageSource(element, baseUrl);
	const alt = linkText(element.getAttribute("alt") ?? "");
	if (!alt || /^(?:https?:)?\/\//i.test(alt) || alt === src) return "";
	return src ? `![${alt}](${src})` : alt;
}

export function isThemeImageTwin(previous: string | undefined, next: string) {
	const previousImage = previous?.match(imageMarkdownPattern);
	const nextImage = next.match(imageMarkdownPattern);
	if (!previousImage || !nextImage || previousImage[1] !== nextImage[1])
		return false;
	const previousTheme = themeVariant(previousImage[2]!);
	const nextTheme = themeVariant(nextImage[2]!);
	return Boolean(previousTheme && nextTheme && nextTheme !== previousTheme);
}

const imageMarkdownPattern = /^!\[([^\]]+)]\(([^)]+)\)$/;
const themeVariant = (src: string) =>
	src.match(/(?:\/|%2f)(light|dark)(?:\/|%2f)/i)?.[1]?.toLowerCase();

function imageSource(element: Element, baseUrl: string) {
	const direct = safeHref(element.getAttribute("src"), baseUrl);
	if (direct) return direct;
	for (const candidate of srcsetCandidates(
		element.getAttribute("srcset") ?? "",
	)) {
		const safe = safeHref(candidate.url, baseUrl);
		if (safe) return safe;
	}
	return undefined;
}

export const escapeTableCell = (value: string) => value.replaceAll("|", "\\|");
export const removePipes = (value: string) =>
	value.replaceAll("\n", " ").replaceAll("|", "");

const controlChromePattern =
	/^(?:ask about this section|copy for llm|show child parameters|hide child parameters|show more parameters|show fewer parameters)$/;

export function pushInline(
	chunks: string[],
	value: string,
	chars: number,
	atomic = false,
) {
	if (!value || chars >= maxInlineChars) return chars;
	const prefix = needsImplicitInlineSpace(chunks.at(-1), value) ? " " : "";
	const available = maxInlineChars - chars - prefix.length;
	if (available <= 0) return chars;
	if (
		atomic &&
		(value.length > available || isThemeImageTwin(chunks.at(-1), value))
	)
		return chars;
	const chunk = value.length > available ? value.slice(0, available) : value;
	chunks.push(prefix ? `${prefix}${chunk}` : chunk);
	return chars + prefix.length + chunk.length;
}

function needsImplicitInlineSpace(previous: string | undefined, next: string) {
	if (!previous || previous.endsWith("_") || next.startsWith("_")) return false;
	return (
		inlineJoinEndPattern.test(previous) &&
		inlineJoinStartPattern.test(next) &&
		!whitespacePattern.test(previous.at(-1) ?? "") &&
		!whitespacePattern.test(next[0] ?? "")
	);
}

export function maxBacktickRun(value: string) {
	let longest = 0;
	for (const match of value.matchAll(/`+/g))
		longest = Math.max(longest, match[0].length);
	return longest;
}

export function srcsetCandidates(input: string, limit = 100) {
	const out: Array<{ url: string; descriptor: string }> = [];
	const whitespace = (char: string) => /[\t\n\f\r ]/.test(char);
	let index = 0;
	while (index < input.length && out.length < limit) {
		while (
			index < input.length &&
			(whitespace(input[index]!) || input[index] === ",")
		)
			index++;
		const start = index;
		while (index < input.length && !whitespace(input[index]!)) index++;
		let url = input.slice(start, index);
		let ended = false;
		while (url.endsWith(",")) {
			url = url.slice(0, -1);
			ended = true;
		}
		if (!url) continue;
		if (ended) {
			out.push({ url, descriptor: "" });
			continue;
		}
		while (index < input.length && whitespace(input[index]!)) index++;
		const descriptorStart = index;
		let parentheses = 0;
		while (index < input.length) {
			const char = input[index++]!;
			if (char === "(") parentheses++;
			else if (char === ")") parentheses = Math.max(0, parentheses - 1);
			else if (char === "," && parentheses === 0) break;
		}
		out.push({
			url,
			descriptor: input
				.slice(descriptorStart, input[index - 1] === "," ? index - 1 : index)
				.trim(),
		});
	}
	return out;
}
