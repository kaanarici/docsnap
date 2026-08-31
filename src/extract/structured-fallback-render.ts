import { decodeEntities } from "./inline-state-scan.ts";
import {
	actsLikeBlock,
	collapseInlineWhitespace,
	escapeTableCell,
	imageMarkdown,
	isElement,
	isLinkDominatedContainer,
	linkText,
	maxBacktickRun,
	maxCodeChars,
	maxDirectChildScan,
	maxInlineChars,
	maxTableCells,
	maxTableFrames,
	maxTableRows,
	pushInline,
	pushNodeChildren,
	removePipes,
	safeHref,
	sanitizeText,
	shouldSkipElement,
	tableBlockTags,
	tagName,
	takeVisit,
	textNode,
	tidyInline,
	type VisitBudget,
	voidTags,
} from "./structured-fallback-shared.ts";

type InlineCheckpoint = { chunks: number; chars: number };
type Frame = {
	node?: Node;
	close?: string;
	checkpoint?: InlineCheckpoint;
};

type TableRow = { cells: Element[]; header: boolean };

export function inlineMarkdown(
	root: Element,
	baseUrl: string,
	budget: VisitBudget,
	options: { skipDefinitionLists?: boolean; skipNestedLists?: boolean } = {},
) {
	const chunks: string[] = [];
	let chars = 0;
	const stack: Frame[] = [{ node: root }];
	const atomicCheckpoints: InlineCheckpoint[] = [];

	while (
		stack.length > 0 &&
		(chars < maxInlineChars || atomicCheckpoints.length > 0) &&
		takeVisit(budget)
	) {
		const frame = stack.pop()!;
		if (frame.close !== undefined) {
			if (frame.checkpoint) {
				atomicCheckpoints.pop();
				if (chars + frame.close.length > maxInlineChars) {
					chunks.length = frame.checkpoint.chunks;
					chars = frame.checkpoint.chars;
					continue;
				}
				chars = pushInline(chunks, frame.close, chars, true);
				continue;
			}
			chars = pushInline(chunks, frame.close, chars);
			continue;
		}
		const node = frame.node;
		if (!node) continue;
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
		if (options.skipDefinitionLists && tag === "dl") continue;
		if (options.skipNestedLists && (tag === "ul" || tag === "ol")) continue;
		if (tag === "br") {
			chars = pushInline(chunks, "\n", chars);
			continue;
		}
		const parent = node.parentNode;
		if (tag === "code" && (!isElement(parent) || tagName(parent) !== "pre")) {
			chars = pushInline(
				chunks,
				inlineCode(collectText(node, maxInlineChars)),
				chars,
				true,
			);
			continue;
		}
		if (tag === "a") {
			const text = linkText(
				collectText(node, maxInlineChars, { spaceBlocks: true }),
			);
			const href = safeHref(node.getAttribute("href"), baseUrl);
			chars = pushInline(
				chunks,
				text && href ? `[${text}](${href})` : text,
				chars,
			);
			continue;
		}
		const emphasis =
			tag === "strong" || tag === "b"
				? "**"
				: tag === "em" || tag === "i"
					? "*"
					: "";
		if (emphasis) {
			if (chars + emphasis.length * 2 > maxInlineChars) continue;
			const checkpoint = { chunks: chunks.length, chars };
			atomicCheckpoints.push(checkpoint);
			stack.push({ node, close: emphasis, checkpoint });
			pushFrameChildren(stack, node, budget.maxVisits - budget.visits);
			chars = pushInline(chunks, emphasis, chars, true);
			continue;
		}
		if (tag === "hr") {
			chars = pushInline(chunks, "\n---\n", chars);
			continue;
		}
		if (tag === "pre") {
			chars = pushInline(chunks, `\n${codeBlock(node)}\n`, chars, true);
			continue;
		}
		if (tag === "img") {
			chars = pushInline(chunks, imageMarkdown(node, baseUrl), chars, true);
			continue;
		}
		if (voidTags.has(tag)) continue;
		pushFrameChildren(stack, node, budget.maxVisits - budget.visits);
	}
	if (atomicCheckpoints.length > 0)
		chunks.length = atomicCheckpoints[0]!.chunks;
	return tidyInline(chunks.join(""));
}
export function codeBlock(element: Element) {
	const source =
		Array.from(element.children).find((child) => tagName(child) === "code") ??
		element;
	const language =
		languageToken(source) ||
		languageToken(element) ||
		adjacentCodeLanguage(element);
	return codeBlockFromText(
		collectText(source, maxCodeChars, { codeLines: true }),
		language,
	);
}

export function codeBlockFromText(value: string, language = "") {
	let body = stripLineNumberGutter(value.slice(0, maxCodeChars));
	const stripPresentation =
		!/^(?:html?|xml|svg|jsx|tsx|vue|svelte|astro)$/i.test(language.trim()) &&
		/<font\b[^>]*\bcolor=|<span\b[^>]*\bstyle=|<u\b[^>]*\bstyle=/i.test(body);
	body = (
		stripPresentation
			? decodeEntities(body).replace(/<\/?(?:font|span|u|b)\b[^>]*>/gi, "")
			: body
	).trimEnd();
	if (!body) return "";
	const fence = "`".repeat(Math.max(3, maxBacktickRun(body) + 1));
	return `${fence}${language}\n${body}\n${fence}`;
}

function stripLineNumberGutter(value: string) {
	const lines = value.replace(/\r\n?/g, "\n").split("\n");
	let cursor = 0;
	while (lines[cursor]?.trim() === String(cursor + 1)) cursor++;
	const body = lines.slice(cursor);
	return cursor >= 3 && body.some((line) => /\S/.test(line))
		? body.join("\n").replace(/^\n+/, "")
		: value;
}

export function renderTable(
	table: Element,
	baseUrl: string,
	budget: VisitBudget,
) {
	const collected = collectTableRows(table, budget);
	if (collected.invalid || collected.rows.length < 2) {
		return tableRowsAsProse(collected.rows, baseUrl, budget);
	}
	const header = collected.rows[0]!;
	const columns = header.cells.length;
	if (
		!header.header ||
		columns === 0 ||
		collected.rows.filter((row) => row.header).length !== 1
	) {
		return tableRowsAsProse(collected.rows, baseUrl, budget);
	}

	const renderedRows: string[][] = [];
	for (const row of collected.rows.slice(1)) {
		if (row.header || row.cells.length > columns)
			return tableRowsAsProse(collected.rows, baseUrl, budget);
		const cells = row.cells.map((cell) =>
			escapeTableCell(inlineCellText(cell, baseUrl, budget)),
		);
		while (cells.length < columns) cells.push("");
		renderedRows.push(cells);
	}

	const headerCells = header.cells.map((cell) =>
		escapeTableCell(inlineCellText(cell, baseUrl, budget)),
	);
	return [
		pipeRow(headerCells),
		pipeRow(headerCells.map(() => "---")),
		...renderedRows.map(pipeRow),
	].join("\n");
}

function inlineCode(value: string) {
	const source = value.replace(/\r\n?/g, "\n").trim();
	if (!source) return "";
	const block = inlineCodeBlock(source);
	if (block) return `\n${block}\n`;
	const code = source.replaceAll("\n", " ");
	const fence = "`".repeat(Math.max(1, maxBacktickRun(code) + 1));
	const pad = code.startsWith("`") || code.endsWith("`") ? " " : "";
	return `${fence}${pad}${code}${pad}${fence}`;
}

function inlineCodeBlock(value: string) {
	if (/^(?:\{|\[)\s/.test(value)) {
		try {
			const json = JSON.stringify(JSON.parse(value), null, 2);
			return codeBlockFromText(json, "json");
		} catch {
			return "";
		}
	}
	if (!/^(?:curl|gh|npm|yarn|pnpm|bun)\b/.test(value)) return "";
	const code = value.replace(/ \\ (?=\S)/g, " \\\n  ");
	return code.length >= 120 || code.includes("\n")
		? codeBlockFromText(code, "bash")
		: "";
}

function collectText(
	root: Element,
	maxChars: number,
	options: { codeLines?: boolean; spaceBlocks?: boolean } = {},
) {
	const chunks: string[] = [];
	let chars = 0;
	let visits = 0;
	const stack: Frame[] = [{ node: root }];
	while (stack.length > 0 && chars < maxChars && visits++ < 4_000) {
		const frame = stack.pop()!;
		if (frame.close) {
			chars = pushCollectedText(chunks, frame.close, chars, maxChars);
			continue;
		}
		const node = frame.node;
		if (!node) continue;
		if (node.nodeType === textNode) {
			const value = node.textContent ?? "";
			if (options.codeLines && isCodeMarkupWhitespace(node, value)) continue;
			chars = pushCollectedText(chunks, value, chars, maxChars);
			continue;
		}
		if (!isElement(node) || (node !== root && shouldSkipElement(node))) {
			continue;
		}
		const tag = tagName(node);
		if (options.codeLines && tag === "br") {
			if (!chunks.at(-1)?.endsWith("\n"))
				chars = pushCollectedText(chunks, "\n", chars, maxChars);
			continue;
		}
		if (node !== root) {
			if (options.codeLines && breaksCodeLine(node, tag)) {
				stack.push({ close: "\n" });
			} else if (options.spaceBlocks && actsLikeBlock(node)) {
				chars = pushCollectedText(chunks, " ", chars, maxChars);
				stack.push({ close: " " });
			}
		}
		pushFrameChildren(stack, node, 4_000 - visits);
	}
	return chunks.join("");
}

const breaksCodeLine = (element: Element, tag: string) =>
	/^(?:div|p)$/.test(tag) &&
	!/(?:^|;)\s*display\s*:\s*inline(?:\s|;|$)/i.test(
		element.getAttribute("style") ?? "",
	);

function pushCollectedText(
	chunks: string[],
	value: string,
	chars: number,
	maxChars: number,
) {
	const chunk = value.slice(0, maxChars - chars);
	chunks.push(chunk);
	return chars + chunk.length;
}

function isCodeMarkupWhitespace(node: Node, value: string) {
	const parent = node.parentNode;
	return (
		/^\s+$/.test(value) &&
		isElement(parent) &&
		Array.from(parent.children).some((child) =>
			/^(?:div|p)$/.test(tagName(child)),
		)
	);
}

function languageToken(element: Element) {
	return (
		(element.getAttribute("class") ?? "").match(
			/(?:^|\s)(?:language-|lang-)([A-Za-z0-9_#+.-]{1,32})(?=$|\s)/,
		)?.[1] ?? ""
	);
}

function adjacentCodeLanguage(element: Element) {
	const match = (element.previousElementSibling?.textContent ?? "")
		.slice(0, 240)
		.match(/\.((?:[cm]?[jt]sx?)|css|html|json|md)(?=[A-Z\s]|$)/i);
	if (!match) return "";
	return match[1]!.toLowerCase();
}

function pushFrameChildren(stack: Frame[], element: Element, limit: number) {
	for (const child of Array.from(element.childNodes)
		.reverse()
		.slice(0, limit)) {
		stack.push({ node: child });
	}
}

function collectTableRows(table: Element, budget: VisitBudget) {
	const rows: TableRow[] = [];
	let invalid = false;
	const stack: Array<{ node: Node; inHead: boolean }> = [
		{ node: table, inHead: false },
	];
	let frames = 1;

	while (stack.length > 0 && rows.length < maxTableRows && takeVisit(budget)) {
		const frame = stack.pop()!;
		if (!isElement(frame.node)) continue;
		const element = frame.node;
		const tag = tagName(element);
		if (element !== table && tag === "table") {
			invalid = true;
			continue;
		}
		const inHead = frame.inHead || tag === "thead";
		if (tag === "tr") {
			const cells = directTableCells(element);
			if (cells.invalid) invalid = true;
			if (cells.cells.length > 0) {
				rows.push({
					cells: cells.cells,
					header: inHead || cells.cells.every((cell) => tagName(cell) === "th"),
				});
			}
			continue;
		}
		const children = element.childNodes;
		for (let index = children.length - 1; index >= 0; index--) {
			if (frames >= maxTableFrames) {
				invalid = true;
				break;
			}
			const child = children[index];
			if (child) {
				stack.push({ node: child, inHead });
				frames++;
			}
		}
	}

	return { invalid, rows };
}

function directTableCells(row: Element) {
	const cells: Element[] = [];
	let invalid = false;
	for (const child of Array.from(row.children).slice(0, maxDirectChildScan)) {
		if (cells.length >= maxTableCells) return { cells, invalid: true };
		const tag = tagName(child);
		if (tag !== "td" && tag !== "th") continue;
		if (
			child.hasAttribute("colspan") ||
			child.hasAttribute("rowspan") ||
			!isInlineOnlyCell(child)
		) {
			invalid = true;
		}
		cells.push(child);
	}
	return { cells, invalid };
}

function isInlineOnlyCell(cell: Element) {
	const stack: Node[] = [cell];
	let visits = 0;
	while (stack.length > 0 && visits++ < 2_000) {
		const node = stack.pop()!;
		if (!isElement(node)) continue;
		if (node !== cell && tableBlockTags.has(tagName(node))) return false;
		pushNodeChildren(stack, node, 2_000 - visits);
	}
	return true;
}

const inlineCellText = (cell: Element, baseUrl: string, budget: VisitBudget) =>
	inlineMarkdown(cell, baseUrl, budget).trim().replaceAll("\n", " ");

function tableRowsAsProse(
	rows: TableRow[],
	baseUrl: string,
	budget: VisitBudget,
) {
	const lines: string[] = [];
	for (const row of rows.slice(0, maxTableRows)) {
		const line = row.cells
			.map((cell) => removePipes(inlineCellText(cell, baseUrl, budget)))
			.filter(Boolean)
			.join(" - ");
		if (line) lines.push(line);
	}
	return lines.join("\n");
}

const pipeRow = (cells: string[]) => `| ${cells.join(" | ")} |`;
