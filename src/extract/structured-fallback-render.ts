import {
	collapseInlineWhitespace,
	escapeTableCell,
	imageMarkdown,
	isElement,
	isLanguageChar,
	isLinkDominatedContainer,
	isMetadataLabel,
	isMetadataLabelHint,
	linkText,
	maxBacktickRun,
	maxCodeChars,
	maxDirectChildScan,
	maxInlineChars,
	maxLanguageChars,
	maxTableCells,
	maxTableFrames,
	maxTableRows,
	pushInline,
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

type InlineCheckpoint = {
	chunks: number;
	chars: number;
};

type InlineFrame = {
	node: Node;
	close?: string;
	checkpoint?: InlineCheckpoint;
};

type TableRow = {
	cells: Element[];
	header: boolean;
};

export function inlineMarkdown(
	root: Element,
	baseUrl: string,
	budget: VisitBudget,
	options: { skipDefinitionLists?: boolean; skipNestedLists?: boolean } = {},
) {
	const chunks: string[] = [];
	let chars = 0;
	const stack: InlineFrame[] = [{ node: root }];
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
		if (options.skipDefinitionLists && tag === "dl") continue;
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
			chars = renderAtomicInline(
				chunks,
				stack,
				atomicCheckpoints,
				node,
				"**",
				chars,
				budget,
			);
			continue;
		}
		if (tag === "em" || tag === "i") {
			chars = renderAtomicInline(
				chunks,
				stack,
				atomicCheckpoints,
				node,
				"*",
				chars,
				budget,
			);
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
	if (atomicCheckpoints.length > 0)
		chunks.length = atomicCheckpoints[0]!.chunks;
	return tidyInline(chunks.join(""));
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

export function renderTable(
	table: Element,
	baseUrl: string,
	budget: VisitBudget,
) {
	const collected = collectTableRows(table, budget);
	const metadata = !collected.invalid
		? renderMetadataTable(collected.rows, baseUrl, budget)
		: undefined;
	if (metadata) return metadata;
	if (collected.invalid || collected.rows.length < 2) {
		return tableRowsAsProse(collected.rows, baseUrl, budget);
	}
	const headerRows = collected.rows.filter((row) => row.header);
	const header = collected.rows[0];
	if (!header || headerRows.length !== 1 || !header.header) {
		return tableRowsAsProse(collected.rows, baseUrl, budget);
	}
	const columns = header.cells.length;
	if (columns === 0) return tableRowsAsProse(collected.rows, baseUrl, budget);

	const renderedRows: string[][] = [];
	for (const row of collected.rows.slice(1)) {
		if (row.header || row.cells.length > columns) {
			return tableRowsAsProse(collected.rows, baseUrl, budget);
		}
		const cells = row.cells.map((cell) =>
			tableCellMarkdown(cell, baseUrl, budget),
		);
		while (cells.length < columns) cells.push("");
		renderedRows.push(cells);
	}
	if (renderedRows.length === 0) {
		return tableRowsAsProse(collected.rows, baseUrl, budget);
	}

	const headerCells = header.cells.map((cell) =>
		tableCellMarkdown(cell, baseUrl, budget),
	);
	const separator = headerCells.map(() => "---");
	return [
		pipeRow(headerCells),
		pipeRow(separator),
		...renderedRows.map(pipeRow),
	].join("\n");
}
function renderMetadataTable(
	rows: TableRow[],
	baseUrl: string,
	budget: VisitBudget,
) {
	if (rows.length < 2) return undefined;
	const probe = { ...budget };
	const rendered: string[] = [];
	let headerLabels = 0;
	let hintedLabels = 0;
	for (const row of rows) {
		if (row.header || row.cells.length !== 2) return undefined;
		const labelCell = row.cells[0]!;
		const label = metadataCellText(labelCell, baseUrl, probe);
		const value = metadataCellText(row.cells[1]!, baseUrl, probe);
		if (!isMetadataLabel(label) || !value) return undefined;
		if (tagName(labelCell) === "th") headerLabels++;
		if (isMetadataLabelHint(label)) hintedLabels++;
		rendered.push(`**${label}**\n: ${value}`);
	}
	if (headerLabels === 0 && hintedLabels === 0) return undefined;
	budget.visits = probe.visits;
	return rendered.join("\n");
}

function metadataCellText(cell: Element, baseUrl: string, budget: VisitBudget) {
	return removePipes(
		inlineMarkdown(cell, baseUrl, budget).trim().replaceAll("\n", " "),
	);
}
function renderAtomicInline(
	chunks: string[],
	stack: InlineFrame[],
	atomicCheckpoints: InlineCheckpoint[],
	node: Element,
	marker: string,
	chars: number,
	budget: VisitBudget,
) {
	if (!fitsInline(`${marker}${marker}`, chars)) return chars;
	const checkpoint = { chunks: chunks.length, chars };
	atomicCheckpoints.push(checkpoint);
	stack.push({ node, close: marker, checkpoint });
	pushInlineChildren(stack, node, budget.maxVisits - budget.visits);
	return pushWholeInline(chunks, marker, chars);
}

function renderLink(element: Element, baseUrl: string) {
	const text = linkText(collectRawText(element));
	if (!text) return "";
	const href = safeHref(element.getAttribute("href"), baseUrl);
	return href ? `[${text}](${href})` : text;
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
	const children = row.childNodes;
	for (
		let index = 0;
		index < children.length && index < maxDirectChildScan;
		index++
	) {
		if (cells.length >= maxTableCells) {
			invalid = true;
			break;
		}
		const child = children[index];
		if (!isElement(child)) continue;
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
		const children = node.childNodes;
		for (let index = children.length - 1; index >= 0; index--) {
			const child = children[index];
			if (child) stack.push(child);
		}
	}
	return true;
}

function tableCellMarkdown(
	cell: Element,
	baseUrl: string,
	budget: VisitBudget,
) {
	return escapeTableCell(
		inlineMarkdown(cell, baseUrl, budget).trim().replaceAll("\n", " "),
	);
}

function tableRowsAsProse(
	rows: TableRow[],
	baseUrl: string,
	budget: VisitBudget,
) {
	const lines: string[] = [];
	for (const row of rows.slice(0, maxTableRows)) {
		const cells = row.cells
			.map((cell) => removePipes(inlineMarkdown(cell, baseUrl, budget).trim()))
			.filter(Boolean);
		if (cells.length > 0) lines.push(cells.join(" - "));
	}
	return lines.join("\n");
}

const pipeRow = (cells: string[]) => `| ${cells.join(" | ")} |`;
