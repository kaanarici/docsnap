import {
	codeBlock,
	inlineMarkdown,
	pushNodeChildren,
} from "./structured-fallback-inline.ts";
import {
	blockTags,
	collapseWhitespace,
	imageMarkdown,
	isElement,
	isHeading,
	isLinkDominatedContainer,
	maxDirectChildScan,
	maxListDepth,
	maxListItems,
	maxOutputChars,
	maxSerializeVisits,
	type OutputState,
	sanitizeText,
	shouldSkipElement,
	tagName,
	takeVisit,
	textNode,
	type VisitBudget,
	voidTags,
} from "./structured-fallback-shared.ts";
import { renderTable } from "./structured-fallback-table.ts";

export function serializeRoot(root: Element, baseUrl: string) {
	const blocks: string[] = [];
	const output: OutputState = { chars: 0 };
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
		if (
			node !== root &&
			(shouldSkipElement(node) || isLinkDominatedContainer(node))
		) {
			continue;
		}

		const tag = tagName(node);
		if (isHeading(tag)) {
			const text = inlineMarkdown(node, baseUrl, budget).trim();
			appendBlock(blocks, `${"#".repeat(Number(tag[1]))} ${text}`, output);
			continue;
		}
		if (tag === "p") {
			appendBlock(blocks, inlineMarkdown(node, baseUrl, budget), output);
			continue;
		}
		if (tag === "pre") {
			appendBlock(blocks, codeBlock(node), output);
			continue;
		}
		if (tag === "ul" || tag === "ol") {
			appendBlock(
				blocks,
				renderList(node, tag === "ol", baseUrl, budget),
				output,
			);
			continue;
		}
		if (tag === "li") {
			appendBlock(
				blocks,
				inlineMarkdown(node, baseUrl, budget, { skipNestedLists: true }),
				output,
			);
			continue;
		}
		if (tag === "table") {
			appendBlock(blocks, renderTable(node, baseUrl, budget), output);
			continue;
		}
		if (tag === "blockquote") {
			appendBlock(
				blocks,
				quoteBlock(inlineMarkdown(node, baseUrl, budget)),
				output,
			);
			continue;
		}
		if (tag === "hr") {
			appendBlock(blocks, "---", output);
			continue;
		}
		if (tag === "dl") {
			appendBlock(blocks, renderDefinitionList(node, baseUrl, budget), output);
			continue;
		}
		if (tag === "img") {
			appendBlock(blocks, imageMarkdown(node, baseUrl), output);
			continue;
		}
		if (voidTags.has(tag)) continue;
		if (hasDirectBlockChild(node)) {
			pushNodeChildren(stack, node, budget.maxVisits - budget.visits);
		} else {
			appendBlock(blocks, inlineMarkdown(node, baseUrl, budget), output);
		}
	}

	return blocks.join("\n\n");
}

function renderDefinitionList(
	list: Element,
	baseUrl: string,
	budget: VisitBudget,
) {
	const lines: string[] = [];
	const children = list.childNodes;
	for (
		let index = 0;
		index < children.length && lines.length < maxListItems;
		index++
	) {
		const child = children[index];
		if (!isElement(child)) continue;
		const tag = tagName(child);
		if (tag === "dt") {
			const term = inlineMarkdown(child, baseUrl, budget).trim();
			if (term) lines.push(`**${term}**`);
		} else if (tag === "dd") {
			const definition = inlineMarkdown(child, baseUrl, budget).trim();
			if (definition) lines.push(`: ${definition}`);
		}
	}
	return lines.join("\n");
}

function renderList(
	list: Element,
	ordered: boolean,
	baseUrl: string,
	budget: VisitBudget,
) {
	const lines: string[] = [];
	const stack: Array<{
		items: Element[];
		ordered: boolean;
		depth: number;
		next: number;
	}> = [{ items: directListItems(list), ordered, depth: 0, next: 0 }];

	while (stack.length > 0 && takeVisit(budget)) {
		const frame = stack[stack.length - 1]!;
		if (frame.next >= frame.items.length) {
			stack.pop();
			continue;
		}
		const item = frame.items[frame.next]!;
		frame.next++;
		const marker = frame.ordered ? `${frame.next}. ` : "- ";
		const indent = "  ".repeat(Math.min(frame.depth, maxListDepth));
		const text = inlineMarkdown(item, baseUrl, budget, {
			skipNestedLists: true,
		}).trim();
		lines.push(`${indent}${marker}${text}`);
		const nested = directNestedLists(item);
		for (let index = nested.length - 1; index >= 0; index--) {
			const child = nested[index]!;
			stack.push({
				items: directListItems(child),
				ordered: tagName(child) === "ol",
				depth: frame.depth + 1,
				next: 0,
			});
		}
	}

	return lines.join("\n");
}

function appendBlock(blocks: string[], block: string, output: OutputState) {
	const clean = block.trim();
	if (!clean || output.chars >= maxOutputChars) return;
	const available = maxOutputChars - output.chars;
	if (clean.length > available && mustStayWhole(clean)) return;
	const value =
		clean.length > available ? clean.slice(0, available).trimEnd() : clean;
	if (!value) return;
	blocks.push(value);
	output.chars += value.length + 2;
}

function mustStayWhole(block: string) {
	return block.startsWith("```") || block.startsWith("| ");
}

function quoteBlock(value: string) {
	const lines = value
		.split("\n")
		.map((line) => (line.trim() ? `> ${line.trim()}` : ">"));
	return lines.join("\n");
}

function directListItems(list: Element) {
	const items: Element[] = [];
	const children = list.childNodes;
	for (
		let index = 0;
		index < children.length && items.length < maxListItems;
		index++
	) {
		const child = children[index];
		if (isElement(child) && tagName(child) === "li") items.push(child);
	}
	return items;
}

function directNestedLists(item: Element) {
	const lists: Element[] = [];
	const children = item.childNodes;
	for (
		let index = 0;
		index < children.length && lists.length < maxListItems;
		index++
	) {
		const child = children[index];
		if (!isElement(child)) continue;
		const tag = tagName(child);
		if (tag === "ul" || tag === "ol") lists.push(child);
	}
	return lists;
}

function hasDirectBlockChild(element: Element) {
	const children = element.childNodes;
	for (
		let index = 0;
		index < children.length && index < maxDirectChildScan;
		index++
	) {
		const child = children[index];
		if (isElement(child) && blockTags.has(tagName(child))) return true;
	}
	return false;
}
