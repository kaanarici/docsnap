import { inlineMarkdown } from "./structured-fallback-inline.ts";
import {
	escapeTableCell,
	isElement,
	maxDirectChildScan,
	maxTableCells,
	maxTableFrames,
	maxTableRows,
	removePipes,
	tableBlockTags,
	tagName,
	takeVisit,
	type VisitBudget,
} from "./structured-fallback-shared.ts";

export function renderTable(
	table: Element,
	baseUrl: string,
	budget: VisitBudget,
) {
	const collected = collectTableRows(table, budget);
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

type TableRow = {
	cells: Element[];
	header: boolean;
};

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
	for (
		let index = 0;
		index < row.childNodes.length && index < maxDirectChildScan;
		index++
	) {
		if (cells.length >= maxTableCells) {
			invalid = true;
			break;
		}
		const child = row.childNodes[index];
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
