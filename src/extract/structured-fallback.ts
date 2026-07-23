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
	emptyStats,
	imageMarkdown,
	isCandidateRoot,
	isElement,
	isHeading,
	isLinkDominatedContainer,
	isPreferredRoot,
	isThemeImageTwin,
	linkDensity,
	maxDirectChildScan,
	maxListDepth,
	maxListItems,
	maxOutputChars,
	maxRootFrames,
	maxSerializeVisits,
	type OutputState,
	pushNodeChildren,
	sanitizeText,
	shouldSkipElement,
	type TextStats,
	tagName,
	takeVisit,
	textNode,
	type VisitBudget,
	voidTags,
} from "./structured-fallback-shared.ts";

type Candidate = TextStats & { element: Element; score: number };
type ScanFrame = { node: Node; inAnchor: boolean; exit: boolean };

export function structuredFallback(
	document: Document,
	baseUrl: string,
): string {
	const root = document.body ?? document.documentElement;
	if (!root) return "";

	const scan = scanRoot(root);
	const chosen = scan.preferred?.element ?? scan.best?.element ?? root;
	const stats = scan.stats.get(chosen) ?? emptyStats();
	const maxDensity = rootLinkDensityLimit(chosen, stats.textChars);
	if (stats.textChars < 40 || linkDensity(stats) > maxDensity) return "";

	const markdown = serializeRoot(chosen, baseUrl).trim();
	return wordCount(markdown) >= 3 ? markdown : "";
}

function scanRoot(root: Element) {
	const stats = new WeakMap<Node, TextStats>();
	const stack: ScanFrame[] = [{ node: root, inAnchor: false, exit: false }];
	let frames = 1;
	let best: Candidate | undefined;
	let preferred: Candidate | undefined;

	while (stack.length > 0 && frames <= maxRootFrames) {
		const frame = stack.pop()!;
		const node = frame.node;
		if (node.nodeType === textNode) {
			const textChars = countTextChars(node.textContent ?? "");
			stats.set(node, {
				textChars,
				anchorChars: frame.inAnchor ? textChars : 0,
			});
			continue;
		}
		if (!isElement(node)) continue;
		if (frame.exit) {
			const total = sumChildStats(node, stats);
			stats.set(node, total);
			const preferredRoot = isPreferredRoot(node);
			const maxDensity = rootLinkDensityLimit(node, total.textChars);
			if (
				total.textChars >= 80 &&
				linkDensity(total) <= maxDensity &&
				(isCandidateRoot(node) || preferredRoot)
			) {
				const candidate: Candidate = {
					element: node,
					score: total.textChars * (1 - linkDensity(total)),
					...total,
				};
				if (preferredRoot) {
					if (!preferred || candidate.score > preferred.score)
						preferred = candidate;
				} else if (!best || candidate.score > best.score) {
					best = candidate;
				}
			}
			continue;
		}
		if (node !== root && shouldSkipElement(node)) {
			stats.set(node, emptyStats());
			continue;
		}
		stack.push({ node, inAnchor: frame.inAnchor, exit: true });
		frames++;
		const children = node.childNodes;
		const childInAnchor = frame.inAnchor || tagName(node) === "a";
		for (let index = children.length - 1; index >= 0; index--) {
			if (frames >= maxRootFrames) break;
			const child = children[index];
			if (!child) continue;
			stack.push({ node: child, inAnchor: childInAnchor, exit: false });
			frames++;
		}
	}

	return {
		...(best ? { best } : {}),
		...(preferred ? { preferred } : {}),
		stats,
	};
}

function rootLinkDensityLimit(element: Element, textChars: number) {
	if (!isPreferredRoot(element)) return 0.5;
	return textChars >= 2_000 && element.querySelector("h1") ? 0.99 : 0.8;
}

function sumChildStats(
	element: Element,
	stats: WeakMap<Node, TextStats>,
): TextStats {
	const total = emptyStats();
	for (const child of element.childNodes) {
		const childStats = stats.get(child);
		if (!childStats) continue;
		total.textChars += childStats.textChars;
		total.anchorChars += childStats.anchorChars;
	}
	return total;
}

function serializeRoot(root: Element, baseUrl: string) {
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
		if (isCodeEditorChrome(node) || isCtaOnlyChrome(node)) continue;
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
		if (tag === "p" || node.getAttribute("data-as") === "p") {
			appendBlock(blocks, inlineMarkdown(node, baseUrl, budget), output);
			continue;
		}
		if (tag === "pre") {
			appendBlock(blocks, codeBlock(node), output);
			continue;
		}
		const editorCode = codeEditorBlock(node);
		if (editorCode) {
			appendBlock(blocks, editorCode, output);
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
		if (hasBlockChild(node)) {
			pushNodeChildren(stack, node, budget.maxVisits - budget.visits);
		} else {
			appendBlock(blocks, inlineMarkdown(node, baseUrl, budget), output);
		}
	}

	return dropStandaloneChromeBlocks(blocks).join("\n\n");
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
		const block =
			tag === "pre"
				? codeBlock(child)
				: tag === "p"
					? inlineMarkdown(child, baseUrl, budget)
					: tag === "table"
						? renderTable(child, baseUrl, budget)
						: tag === "blockquote"
							? quoteBlock(inlineMarkdown(child, baseUrl, budget))
							: tag === "dl"
								? renderDefinitionList(child, baseUrl, budget)
								: undefined;
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
	if (!clean || output.chars >= maxOutputChars) return;
	const available = maxOutputChars - output.chars;
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
	return Array.from(element.children)
		.slice(0, maxDirectChildScan)
		.some(
			(child) =>
				actsLikeBlock(child) ||
				(tagName(child).includes("-") &&
					Array.from(child.children).some(actsLikeBlock)),
		);
}
