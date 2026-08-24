import { wordCount } from "../core/text.ts";
import { decodeEntities } from "./inline-state-scan.ts";
import {
	codeBlock,
	codeBlockFromText,
	inlineMarkdown,
	renderTable,
} from "./structured-fallback-render.ts";
import {
	actsLikeBlock,
	collapseWhitespace,
	countTextChars,
	imageMarkdown,
	isElement,
	isHeading,
	isLinkDominatedContainer,
	isThemeImageTwin,
	maxDirectChildScan,
	maxListDepth,
	maxListItems,
	maxOutputChars,
	maxSerializeVisits,
	pushNodeChildren,
	sanitizeText,
	shouldSkipElement,
	tagName,
	takeVisit,
	textNode,
	type VisitBudget,
	voidTags,
} from "./structured-fallback-shared.ts";

type OutputState = { chars: number; truncated: boolean };

export function structuredFallback(document: Document, baseUrl: string) {
	const root = document.body ?? document.documentElement;
	if (!root) return { markdown: "", truncated: false };

	const candidates = Array.from(
		document.querySelectorAll("main,[role=main],article"),
	).filter((candidate) => !shouldSkipElement(candidate));
	let best: { markdown: string; score: number; truncated: boolean } | undefined;
	for (const candidate of candidates.length > 0 ? candidates : [root]) {
		const serialized = serializeRoot(candidate, baseUrl);
		const markdown = serialized.markdown.trim();
		const stats = markdownStats(markdown);
		const limit =
			candidate === root ? 0.5 : markdown.length >= 2_000 ? 0.99 : 0.8;
		const minText = /^```/m.test(markdown) ? 20 : 40;
		const score = stats.text - stats.linked;
		if (
			stats.text >= minText &&
			stats.linked / Math.max(1, stats.text) <= limit &&
			wordCount(markdown) >= 3 &&
			(!best || score > best.score)
		) {
			best = { markdown, score, truncated: serialized.truncated };
		}
	}
	return {
		markdown: best?.markdown ?? "",
		truncated: best?.truncated ?? false,
	};
}

function markdownStats(markdown: string) {
	let linked = 0;
	const text = markdown
		.replace(/!\[[^\]]*]\([^)]+\)/g, "")
		.replace(/\[([^\]]+)]\([^)]+\)/g, (_match, label) => {
			linked += countTextChars(label);
			return label;
		})
		.replace(/[#*_`>|~-]/g, "");
	return { linked, text: countTextChars(text) };
}

function serializeRoot(root: Element, baseUrl: string) {
	const blocks: string[] = [];
	const output: OutputState = { chars: 0, truncated: false };
	const budget: VisitBudget = { visits: 0, maxVisits: maxSerializeVisits };
	const stack: Node[] = [root];

	while (stack.length > 0 && takeVisit(budget)) {
		const node = stack.pop()!;
		if (node.nodeType === textNode) {
			appendBlock(
				blocks,
				sanitizeText(collapseWhitespace(node.textContent ?? "")),
				output,
			);
			continue;
		}
		if (!isElement(node)) continue;
		if (isCodeEditorChrome(node) || isCtaOnlyChrome(node)) continue;
		if (
			node !== root &&
			(shouldSkipElement(node) || isLinkDominatedContainer(node))
		) {
			continue;
		}

		const tag = tagName(node);
		const block = renderElement(node, tag, baseUrl, budget);
		if (block !== undefined) {
			appendBlock(blocks, block, output);
			continue;
		}
		if (voidTags.has(tag)) continue;
		if (hasBlockChild(node)) {
			pushNodeChildren(stack, node, budget.maxVisits - budget.visits);
		} else {
			appendBlock(blocks, inlineMarkdown(node, baseUrl, budget), output);
		}
	}

	return {
		markdown: dropStandaloneChromeBlocks(blocks).join("\n\n"),
		truncated:
			output.truncated ||
			budget.truncated === true ||
			budget.visits >= budget.maxVisits ||
			stack.length > 0,
	};
}

function renderElement(
	element: Element,
	tag: string,
	baseUrl: string,
	budget: VisitBudget,
) {
	if (isHeading(tag)) {
		return `${"#".repeat(Number(tag[1]))} ${inlineMarkdown(element, baseUrl, budget).trim()}`;
	}
	const common = commonBlock(element, tag, baseUrl, budget);
	if (common !== undefined) return common;
	const editorCode = codeEditorBlock(element);
	if (editorCode) return editorCode;
	if (tag === "ul" || tag === "ol")
		return renderList(element, tag === "ol", baseUrl, budget);
	if (tag === "li")
		return inlineMarkdown(element, baseUrl, budget, { skipNestedLists: true });
	if (tag === "hr") return "---";
	if (tag === "img") return imageMarkdown(element, baseUrl);
	if (element.getAttribute("data-as") === "p")
		return inlineMarkdown(element, baseUrl, budget);
	return undefined;
}

function commonBlock(
	element: Element,
	tag: string,
	baseUrl: string,
	budget: VisitBudget,
) {
	if (tag === "p") return inlineMarkdown(element, baseUrl, budget);
	if (tag === "pre") return codeBlock(element);
	if (tag === "table") return renderTable(element, baseUrl, budget);
	if (tag === "blockquote")
		return quoteBlock(inlineMarkdown(element, baseUrl, budget));
	if (tag === "dl") return renderDefinitionList(element, baseUrl, budget);
	return undefined;
}

function isCodeEditorChrome(element: Element) {
	if (!element.closest(codeEditorSelector)) return false;
	const text = collapseWhitespace(element.textContent ?? "");
	return (
		(tagName(element) === "label" && text === "Edit code") ||
		(element.getAttribute("aria-live")?.toLowerCase() === "polite" &&
			/^Press Enter to start editing$/i.test(text))
	);
}

function isCtaOnlyChrome(element: Element) {
	if (element.getAttribute("data-component-part") !== "card-cta") return false;
	const text = collapseWhitespace(element.textContent ?? "").toLowerCase();
	return /^(?:learn more|read more|view docs|view documentation)$/.test(text);
}

function codeEditorBlock(element: Element) {
	if (tagName(element) !== "textarea" || !element.closest(codeEditorSelector))
		return "";
	const source = decodeEntities(element.textContent ?? "");
	if (!/<[A-Z][\w.:-]*(?:\s|>|\/)/.test(source)) return "";
	const language =
		element.parentElement
			?.querySelector("pre code[class*='language-']")
			?.getAttribute("class")
			?.match(/(?:^|\s)language-([A-Za-z0-9_#+.-]{1,32})(?=$|\s)/)?.[1] ??
		"jsx";
	return codeBlockFromText(
		source.replace(/\r\n?/g, "\n").replace(/>\s+</g, ">\n<").trim(),
		language,
	);
}

const codeEditorSelector =
	".MuiCode-root,.scrollContainer,.npm__react-simple-code-editor__textarea";

function renderDefinitionList(
	list: Element,
	baseUrl: string,
	budget: VisitBudget,
) {
	const lines: string[] = [];
	const stack: Node[] = [];
	const ddHasTerm = new Map<Element, boolean>();
	pushNodeChildren(stack, list, maxDirectChildScan);
	while (stack.length > 0 && lines.length < maxListItems && takeVisit(budget)) {
		const child = stack.pop()!;
		if (!isElement(child)) continue;
		const tag = tagName(child);
		if (tag !== "dt" && tag !== "dd") {
			pushNodeChildren(stack, child, maxDirectChildScan);
			continue;
		}
		const text = inlineMarkdown(child, baseUrl, budget, {
			skipDefinitionLists: true,
		}).trim();
		if (tag === "dt") {
			if (text) lines.push(`**${text}**`);
			for (
				let sibling = child.nextElementSibling;
				sibling && tagName(sibling) === "dd";
				sibling = sibling.nextElementSibling
			)
				ddHasTerm.set(sibling, Boolean(text));
		} else if (text) {
			lines.push(ddHasTerm.get(child) ? `: ${text}` : text);
		}
		pushNestedDefinitionLists(stack, child, budget);
	}
	return lines.join("\n");
}

function pushNestedDefinitionLists(
	stack: Node[],
	element: Element,
	budget: VisitBudget,
) {
	const found: Element[] = [];
	const scan = Array.from(element.children).reverse();
	while (scan.length > 0 && found.length < maxListItems && takeVisit(budget)) {
		const node = scan.pop()!;
		if (tagName(node) === "dl") found.push(node);
		else scan.push(...Array.from(node.children).reverse());
	}
	for (const node of found.reverse()) stack.push(node);
}

function renderList(
	list: Element,
	ordered: boolean,
	baseUrl: string,
	budget: VisitBudget,
) {
	const lines: string[] = [];
	const stack = [
		{ items: directListItems(list), ordered, depth: 0, next: 0, indent: "" },
	];

	while (stack.length > 0 && takeVisit(budget)) {
		const frame = stack[stack.length - 1]!;
		if (frame.next >= frame.items.length) {
			stack.pop();
			continue;
		}
		const item = frame.items[frame.next]!;
		frame.next++;
		const marker = frame.ordered ? `${frame.next}. ` : "- ";
		const childIndent =
			frame.indent +
			(frame.depth >= maxListDepth ? "" : " ".repeat(marker.length));
		const text =
			renderListItemContent(item, baseUrl, budget) ||
			inlineMarkdown(item, baseUrl, budget, { skipNestedLists: true }).trim();
		lines.push(...listItemLines(frame.indent, marker, text));
		for (const child of directNestedLists(item).reverse()) {
			stack.push({
				items: directListItems(child),
				ordered: tagName(child) === "ol",
				depth: frame.depth + 1,
				next: 0,
				indent: childIndent,
			});
		}
	}

	return lines.join("\n");
}

function renderListItemContent(
	root: Element,
	baseUrl: string,
	budget: VisitBudget,
) {
	const blocks: string[] = [];
	const inline: string[] = [];
	const flushInline = () => {
		const text = inline.splice(0).join(" ").trim();
		if (text) blocks.push(text);
	};
	const pushBlock = (value: string) => {
		const clean = value.trim();
		if (clean) blocks.push(clean);
	};
	const limit = Math.min(root.childNodes.length, maxDirectChildScan);
	for (let index = 0; index < limit && takeVisit(budget); index++) {
		const child = root.childNodes[index];
		if (!child) continue;
		if (child.nodeType === textNode) {
			const text = sanitizeText(collapseWhitespace(child.textContent ?? ""));
			if (text) inline.push(text);
			continue;
		}
		if (
			!isElement(child) ||
			shouldSkipElement(child) ||
			isLinkDominatedContainer(child)
		) {
			continue;
		}
		const tag = tagName(child);
		if (tag === "ul" || tag === "ol" || tag === "li") continue;
		const block = commonBlock(child, tag, baseUrl, budget);
		if (block !== undefined) {
			flushInline();
			pushBlock(block);
			continue;
		}
		if (actsLikeBlock(child) || hasBlockChild(child)) {
			flushInline();
			pushBlock(renderListItemContent(child, baseUrl, budget));
			continue;
		}
		const text = inlineMarkdown(child, baseUrl, budget).trim();
		if (text) inline.push(text);
	}
	flushInline();
	return blocks.join("\n\n");
}

function listItemLines(indent: string, marker: string, text: string) {
	if (!text) return [];
	const continuation = `${indent}${" ".repeat(marker.length)}`;
	return text.split("\n").map((line, index) => {
		if (index === 0) return `${indent}${marker}${line}`;
		return line ? `${continuation}${line}` : continuation.trimEnd();
	});
}

function appendBlock(blocks: string[], block: string, output: OutputState) {
	const clean = block.trim();
	if (!clean) return;
	if (output.chars >= maxOutputChars) {
		output.truncated = true;
		return;
	}
	const available = maxOutputChars - output.chars;
	if (clean.length > available) output.truncated = true;
	if (clean.length > available && /^(?:```|\| )/.test(clean)) return;
	const value =
		clean.length > available ? clean.slice(0, available).trimEnd() : clean;
	if (!value || isThemeImageTwin(blocks.at(-1), value)) return;
	blocks.push(value);
	output.chars += value.length + 2;
}

function dropStandaloneChromeBlocks(blocks: string[]) {
	const out: string[] = [];
	for (let index = 0; index < blocks.length; index++) {
		const block = blocks[index]!;
		if (feedbackFooterStartPattern.test(block)) break;
		if (standaloneChromeBlockPattern.test(block)) continue;
		if (/^Select [A-Za-z][A-Za-z ]{0,40} Version:?$/i.test(block)) {
			if (versionSelectorChoicePattern.test(blocks[index + 1] ?? "")) index++;
			continue;
		}
		out.push(block);
	}
	return out;
}

const versionSelectorChoicePattern = /^Version [A-Za-z0-9_.-]+(?: \([^)]+\))?$/;
const feedbackFooterStartPattern =
	/^(?:#{2,3} Help improve MDN|\[Edit this page on GitHub]\(|\d+ contributors?$|Last edited by \[)/i;
const standaloneChromeBlockPattern =
	/^(?:#{1,6}\s*)?(?:copy as markdown|copy page as markdown(?: \[open in (?:chatgpt|claude|cursor)]\([^)]+\))*|copy to clipboard|copied!|on this page|tool navigation|in this article|table of contents|wrap text)$/i;

const quoteBlock = (value: string) =>
	value.replace(/^.*$/gm, (line) => (line.trim() ? `> ${line.trim()}` : ">"));

const directListItems = (list: Element) =>
	Array.from(list.children)
		.filter((child) => tagName(child) === "li")
		.slice(0, maxListItems);

function directNestedLists(item: Element) {
	const lists: Element[] = [];
	const scan = Array.from(item.children);
	for (let scanned = 0; scanned < scan.length; scanned++) {
		if (lists.length >= maxListItems || scanned >= maxDirectChildScan) break;
		const node = scan[scanned]!;
		const tag = tagName(node);
		if (tag === "ul" || tag === "ol") lists.push(node);
		else if (tag !== "li") scan.push(...Array.from(node.children));
	}
	return lists;
}

function hasBlockChild(element: Element) {
	const stack = Array.from(element.children).reverse();
	for (let scanned = 0; stack.length > 0 && scanned < 240; scanned++) {
		const child = stack.pop()!;
		if (actsLikeBlock(child)) return true;
		if (!shouldSkipElement(child))
			stack.push(...Array.from(child.children).reverse());
	}
	return false;
}
