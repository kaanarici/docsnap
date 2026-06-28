const elementNode = 1;
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

export type TextStats = { textChars: number; anchorChars: number };

export type VisitBudget = { visits: number; maxVisits: number };

export type OutputState = { chars: number };

export const emptyStats = (): TextStats => ({ textChars: 0, anchorChars: 0 });
export const linkDensity = (stats: TextStats) =>
	stats.textChars === 0 ? 1 : stats.anchorChars / stats.textChars;

export function takeVisit(budget: VisitBudget) {
	return budget.visits < budget.maxVisits && ++budget.visits > 0;
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

export const isCandidateRoot = (element: Element) =>
	rootCandidateTags.has(tagName(element));

export function isHeading(tag: string) {
	return tag.length === 2 && tag[0] === "h" && tag[1]! >= "1" && tag[1]! <= "6";
}

export function actsLikeBlock(element: Element) {
	return (
		blockTags.has(tagName(element)) ||
		element.getAttribute("data-as") === "p" ||
		element.getAttribute("data-component-part") === "card-cta"
	);
}

export function shouldSkipElement(element: Element) {
	return (
		skipTags.has(tagName(element)) ||
		isChromeElement(element) ||
		isWidgetChrome(element) ||
		isHiddenElement(element)
	);
}

function isWidgetChrome(element: Element) {
	const tag = tagName(element);
	return isShareChrome(element, tag) || isSubscriptionChrome(element, tag);
}

function isChromeElement(element: Element) {
	const tag = tagName(element);
	const elementRole = role(element);
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

const role = (element: Element) => element.getAttribute("role")?.toLowerCase();

function isCodeCopyControl(element: Element, tag: string) {
	if (tag !== "button") return false;
	const label = collapseWhitespace(
		`${element.getAttribute("aria-label") ?? ""} ${element.getAttribute("title") ?? ""}`,
	).toLowerCase();
	const className = element.getAttribute("class")?.toLowerCase() ?? "";
	return (
		label === "copy code" ||
		label === "copy the code" ||
		className.includes("code-copy") ||
		className.includes("copy-code") ||
		className.includes("muicode-copy")
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

function isHiddenElement(element: Element) {
	return (
		element.hasAttribute("hidden") ||
		element.getAttribute("aria-hidden")?.toLowerCase() === "true" ||
		(element
			.getAttribute("class")
			?.split(/\s+/)
			.some((token) => hiddenClassTokens.has(token)) ??
			false) ||
		styleHidesElement(element.getAttribute("style") ?? "")
	);
}

export function isLinkDominatedContainer(element: Element) {
	const tag = tagName(element);
	if (tag !== "article" && tag !== "section" && tag !== "div") return false;
	if (hasNearbyHeading(element)) return false;
	const stats = quickTextStats(element);
	return stats.textChars >= 20 && linkDensity(stats) > 0.7;
}

function hasNearbyHeading(element: Element) {
	const stack: Array<{ node: Node; depth: number }> = [
		{ node: element, depth: 0 },
	];
	let visits = 0;
	while (stack.length > 0 && visits++ < 240) {
		const { node, depth } = stack.pop()!;
		if (!isElement(node)) continue;
		if (node !== element && isHeading(tagName(node))) return true;
		if (depth >= 3 || shouldSkipElement(node)) continue;
		const children = node.childNodes;
		for (let index = children.length - 1; index >= 0; index--) {
			const child = children[index];
			if (child) stack.push({ node: child, depth: depth + 1 });
		}
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
	return /(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*hidden)/i.test(
		style.slice(0, 2_048),
	);
}

const rootCandidateTags = wordSet("article main section div table td");
const allowedSchemes = wordSet("http: https: mailto:");
const chromeTags = wordSet("nav header footer aside");
const chromeRoles = wordSet("navigation tab tablist");
const contentBlockTags = wordSet("code h1 h2 h3 h4 h5 h6 p pre table");
const interactiveTags = wordSet("a button input select textarea");
const shareCandidateTags = wordSet("div section ul ol");
const subscriptionCandidateTags = wordSet("div section form");
const hiddenClassTokens = wordSet("hidden sr-only visually-hidden");
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
const unsafeHrefPattern = rawPattern(String.raw`[)<>" \n\r\t\f\x00-\x1F\x7F]`);
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
		.replace(/([.)]["”]?)(?=(?:Default|Can be|Properties of)\b)/g, "$1 ")
		.replace(/\b(Default: (?:`[^`\n]+`|[^.\n]{1,80})) Can be\b/g, "$1. Can be")
		.replace(/\bProperties of (`[^`\n]+`)(?= `)/g, "\nProperties of $1\n")
		.replace(
			/\nProperties of (`[^`\n]+`)\n([\s\S]*?)(?=\nProperties of `|$)/g,
			(_match, label, body) =>
				`\nProperties of ${label}\n${body.replace(/ (?=(`[^`\n]+`) (?:object|array|string|boolean|integer|number|null)\b)/g, "\n")}`,
		)
		.replace(/@@F(\d+)@@\n? ?\. (?=[A-Z])/g, "@@F$1@@\n")
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
		return stripped.startsWith("//") ? resolved.href : stripped;
	} catch {
		return undefined;
	}
}

export function imageMarkdown(element: Element, baseUrl: string) {
	const src = imageSource(element, baseUrl);
	const alt = linkText(element.getAttribute("alt") ?? "");
	if (!alt || urlLikeImageAlt(alt, src)) return "";
	return src ? `![${alt}](${src})` : alt;
}

function urlLikeImageAlt(alt: string, src: string | undefined) {
	return /^(?:https?:)?\/\//i.test(alt) || (src !== undefined && alt === src);
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
	for (const part of (element.getAttribute("srcset") ?? "").split(",")) {
		const candidate = part.trim().split(/\s+/, 1)[0];
		const safe = safeHref(candidate ?? "", baseUrl);
		if (safe) return safe;
	}
	return undefined;
}

export function escapeTableCell(value: string) {
	return value.replaceAll("|", "\\|");
}

export function removePipes(value: string) {
	return value.replaceAll("\n", " ").replaceAll("|", "");
}

const controlChromePattern =
	/^(?:ask about this section|copy for llm|show child parameters|hide child parameters|show more parameters|show fewer parameters)$/;

export function pushInline(chunks: string[], value: string, chars: number) {
	if (!value || chars >= maxInlineChars) return chars;
	const prefix = needsImplicitInlineSpace(chunks.at(-1), value) ? " " : "";
	const available = maxInlineChars - chars - prefix.length;
	if (available <= 0) return chars;
	const chunk = value.length > available ? value.slice(0, available) : value;
	chunks.push(prefix ? `${prefix}${chunk}` : chunk);
	return chars + prefix.length + chunk.length;
}

export function needsImplicitInlineSpace(
	previous: string | undefined,
	next: string,
) {
	if (!previous || previous.endsWith("_") || next.startsWith("_")) return false;
	return (
		inlineJoinEndPattern.test(previous) &&
		inlineJoinStartPattern.test(next) &&
		!whitespacePattern.test(previous.at(-1) ?? "") &&
		!whitespacePattern.test(next[0] ?? "")
	);
}

export function maxBacktickRun(value: string) {
	return Math.max(
		0,
		...Array.from(value.matchAll(/`+/g), (match) => match[0].length),
	);
}
