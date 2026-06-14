import {
	collapseInlineWhitespace,
	imageMarkdown,
	isElement,
	isLanguageChar,
	isLinkDominatedContainer,
	linkText,
	maxBacktickRun,
	maxCodeChars,
	maxInlineChars,
	maxLanguageChars,
	pushInline,
	safeHref,
	sanitizeText,
	shouldSkipElement,
	tagName,
	textNode,
	tidyInline,
	type VisitBudget,
	voidTags,
} from "./structured-fallback-shared.ts";

export function inlineMarkdown(
	root: Element,
	baseUrl: string,
	budget: VisitBudget,
	options: { skipNestedLists?: boolean } = {},
) {
	const chunks: string[] = [];
	let chars = 0;
	const stack: InlineFrame[] = [{ node: root }];
	const atomicCheckpoints: InlineCheckpoint[] = [];

	while (
		stack.length > 0 &&
		(chars < maxInlineChars || atomicCheckpoints.length > 0) &&
		takeInlineVisit(budget)
	) {
		const frame = stack.pop()!;
		if (frame.close !== undefined) {
			if (frame.checkpoint) {
				atomicCheckpoints.pop();
				if (!fitsInline(frame.close, chars)) {
					chunks.length = frame.checkpoint.chunks;
					chars = frame.checkpoint.chars;
					continue;
				}
				chars = pushWholeInline(chunks, frame.close, chars);
				continue;
			}
			chars = pushInline(chunks, frame.close, chars);
			continue;
		}
		const node = frame.node;
		if (node.nodeType === textNode) {
			chars = pushInline(
				chunks,
				sanitizeText(collapseInlineWhitespace(node.textContent ?? "")),
				chars,
			);
			continue;
		}
		if (!isElement(node)) continue;
		if (
			node !== root &&
			(shouldSkipElement(node) || isLinkDominatedContainer(node))
		) {
			continue;
		}
		const tag = tagName(node);
		if (options.skipNestedLists && (tag === "ul" || tag === "ol")) continue;
		if (tag === "br") {
			chars = pushInline(chunks, "\n", chars);
			continue;
		}
		const parent = node.parentNode;
		if (tag === "code" && (!isElement(parent) || tagName(parent) !== "pre")) {
			chars = pushWholeInline(chunks, inlineCode(collectRawText(node)), chars);
			continue;
		}
		if (tag === "a") {
			chars = pushInline(chunks, renderLink(node, baseUrl), chars);
			continue;
		}
		if (tag === "strong" || tag === "b") {
			const marker = "**";
			if (!fitsInline(`${marker}${marker}`, chars)) continue;
			const checkpoint = { chunks: chunks.length, chars };
			atomicCheckpoints.push(checkpoint);
			stack.push({ node, close: marker, checkpoint });
			pushInlineChildren(stack, node, budget.maxVisits - budget.visits);
			chars = pushWholeInline(chunks, marker, chars);
			continue;
		}
		if (tag === "em" || tag === "i") {
			const marker = "*";
			if (!fitsInline(`${marker}${marker}`, chars)) continue;
			const checkpoint = { chunks: chunks.length, chars };
			atomicCheckpoints.push(checkpoint);
			stack.push({ node, close: marker, checkpoint });
			pushInlineChildren(stack, node, budget.maxVisits - budget.visits);
			chars = pushWholeInline(chunks, marker, chars);
			continue;
		}
		if (tag === "hr") {
			chars = pushInline(chunks, "\n---\n", chars);
			continue;
		}
		if (tag === "pre") {
			chars = pushWholeInline(chunks, codeBlock(node), chars);
			continue;
		}
		if (tag === "img") {
			chars = pushWholeInline(chunks, imageMarkdown(node, baseUrl), chars);
			continue;
		}
		if (voidTags.has(tag)) continue;
		pushInlineChildren(stack, node, budget.maxVisits - budget.visits);
	}
	if (atomicCheckpoints.length > 0) {
		chunks.length = atomicCheckpoints[0]!.chunks;
	}

	return tidyInline(chunks.join(""));
}

type InlineCheckpoint = {
	chunks: number;
	chars: number;
};

type InlineFrame = {
	node: Node;
	close?: string;
	checkpoint?: InlineCheckpoint;
};

function renderLink(element: Element, baseUrl: string) {
	const text = linkText(collectRawText(element));
	if (!text) return "";
	const href = safeHref(element.getAttribute("href"), baseUrl);
	return href ? `[${text}](${href})` : text;
}

export function codeBlock(element: Element) {
	const codeElement = firstElementChildWithTag(element, "code");
	const source = codeElement ?? element;
	const language = languageToken(source);
	const body = collectRawText(source).slice(0, maxCodeChars).trimEnd();
	if (!body) return "";
	const fence = "`".repeat(Math.max(3, maxBacktickRun(body) + 1));
	return `${fence}${language}\n${body}\n${fence}`;
}

function inlineCode(value: string) {
	const code = value.replaceAll("\n", " ");
	if (!code) return "";
	const fence = "`".repeat(Math.max(1, maxBacktickRun(code) + 1));
	const pad = code.startsWith("`") || code.endsWith("`") ? " " : "";
	return `${fence}${pad}${code}${pad}${fence}`;
}

function collectRawText(root: Element) {
	const chunks: string[] = [];
	let chars = 0;
	let visits = 0;
	const stack: Node[] = [root];
	while (stack.length > 0 && chars < maxInlineChars && visits++ < 4_000) {
		const node = stack.pop()!;
		if (node.nodeType === textNode) {
			const value = node.textContent ?? "";
			const available = maxInlineChars - chars;
			chunks.push(value.length > available ? value.slice(0, available) : value);
			chars += value.length;
			continue;
		}
		if (
			!isElement(node) ||
			(node !== root &&
				(shouldSkipElement(node) || isLinkDominatedContainer(node)))
		) {
			continue;
		}
		pushNodeChildren(stack, node, 4_000 - visits);
	}
	return chunks.join("");
}

function languageToken(element: Element) {
	const className = element.getAttribute("class") ?? "";
	for (const marker of ["language-", "lang-"]) {
		const start = className.indexOf(marker);
		if (start < 0) continue;
		return readLanguage(className, start + marker.length);
	}
	return "";
}

function readLanguage(value: string, start: number) {
	const chars: string[] = [];
	for (
		let index = start;
		index < value.length && chars.length < maxLanguageChars;
		index++
	) {
		const char = value[index]!;
		if (!isLanguageChar(char)) break;
		chars.push(char);
	}
	return chars.length > 0 ? chars.join("") : "";
}

export function pushNodeChildren(
	stack: Node[],
	element: Element,
	limit: number,
) {
	const children = element.childNodes;
	let pushed = 0;
	for (let index = children.length - 1; index >= 0; index--) {
		if (pushed >= limit) break;
		const child = children[index];
		if (child) {
			stack.push(child);
			pushed++;
		}
	}
}

function pushInlineChildren(
	stack: InlineFrame[],
	element: Element,
	limit: number,
) {
	const children = element.childNodes;
	let pushed = 0;
	for (let index = children.length - 1; index >= 0; index--) {
		if (pushed >= limit) break;
		const child = children[index];
		if (child) {
			stack.push({ node: child });
			pushed++;
		}
	}
}

function firstElementChildWithTag(element: Element, tag: string) {
	const children = element.childNodes;
	for (let index = 0; index < children.length; index++) {
		const child = children[index];
		if (isElement(child) && tagName(child) === tag) return child;
	}
	return undefined;
}

function pushWholeInline(chunks: string[], value: string, chars: number) {
	if (!fitsInline(value, chars)) return chars;
	chunks.push(value);
	return chars + value.length;
}

function fitsInline(value: string, chars: number) {
	return Boolean(value) && chars + value.length <= maxInlineChars;
}

function takeInlineVisit(budget: VisitBudget) {
	if (budget.visits >= budget.maxVisits) return false;
	budget.visits++;
	return true;
}
