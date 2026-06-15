import { markdownLinkHrefs } from "../core/markdown.ts";

export function titleFromMarkdown(markdown: string, fallback: string): string {
	return markdown.match(/^#\s+(.+)$/m)?.[1]?.trim() || fallback;
}

export function linksFromMarkdown(markdown: string): string[] {
	return markdownLinkHrefs(markdown);
}

export function cleanMarkdown(markdown: string): string {
	let fence: Fence | undefined;
	let componentDepth = 0;
	const lines: string[] = [];

	for (const rawLine of stripIndexBanner(markdown).split("\n")) {
		const line = stripComponentIndent(rawLine, componentDepth);
		if (fence) {
			lines.push(line);
			if (closesFence(line, fence)) fence = undefined;
			continue;
		}
		const component = componentLine(line);
		if (component) {
			if (component.kind === "close")
				componentDepth = Math.max(0, componentDepth - 1);
			if (component.kind === "open") {
				if (component.line !== undefined) lines.push(component.line);
				if (!component.selfClosing) componentDepth++;
			}
			continue;
		}

		const opened = openFence(line);
		if (opened) {
			fence = opened.fence;
			lines.push(opened.line);
			continue;
		}

		lines.push(line);
	}

	return normalizeImageAlt(
		lines
			.join("\n")
			.replace(/\n{3,}/g, "\n\n")
			.trim(),
	);
}

const maxAltChars = 250;

// defuddle can emit a multi-line stock-photo caption as image alt text, which
// bloats the corpus and reads like body prose; collapse alt whitespace and cap
// egregious captions. Linear indexOf scan (no backtracking regex) so it can't
// ReDoS on hostile markdown.
function normalizeImageAlt(markdown: string): string {
	if (!markdown.includes("![")) return markdown;
	let out = "";
	let cursor = 0;
	while (cursor < markdown.length) {
		const open = markdown.indexOf("![", cursor);
		if (open < 0) {
			out += markdown.slice(cursor);
			break;
		}
		const altStart = open + 2;
		const altEnd = markdown.indexOf("](", altStart);
		const srcEnd = altEnd < 0 ? -1 : markdown.indexOf(")", altEnd + 2);
		if (altEnd < 0 || srcEnd < 0) {
			out += markdown.slice(cursor, altStart);
			cursor = altStart;
			continue;
		}
		out += markdown.slice(cursor, altStart);
		out += cappedAlt(markdown.slice(altStart, altEnd));
		out += markdown.slice(altEnd, srcEnd + 1);
		cursor = srcEnd + 1;
	}
	return out;
}

function cappedAlt(alt: string): string {
	if (alt.length <= maxAltChars && !/\n|\s\s/.test(alt)) return alt;
	const collapsed = alt.replace(/\s+/g, " ").trim();
	return collapsed.length > maxAltChars
		? `${collapsed.slice(0, maxAltChars - 1)}…`
		: collapsed;
}

type Fence = { marker: "`" | "~"; length: number };
type ComponentLine =
	| { kind: "close" }
	| { kind: "drop" }
	| { kind: "open"; line?: string; selfClosing: boolean };

const wrappers = new Set([
	"AccordionGroup",
	"CardGroup",
	"CodeGroup",
	"Frame",
	"Info",
	"Note",
	"Steps",
	"Tabs",
	"Tip",
	"Warning",
]);

const titledBlocks = new Set(["Accordion", "Card", "Step", "Tab"]);

function componentLine(line: string): ComponentLine | undefined {
	const indent = line.match(/^\s*/)?.[0] ?? "";
	if (indent.length > 3) return undefined;

	const trimmed = line.trim();
	if (/^<iframe\b[^>]*\/?>$/i.test(trimmed)) return { kind: "drop" };

	const tag = trimmed.match(/^<\/?([A-Z][A-Za-z0-9]*)(?:\s[^>]*)?>$/);
	if (!tag) return undefined;

	const name = tag[1]!;
	if (trimmed.startsWith("</")) {
		return wrappers.has(name) || titledBlocks.has(name)
			? { kind: "close" }
			: undefined;
	}

	const selfClosing = trimmed.endsWith("/>");
	if (titledBlocks.has(name)) {
		const title = attr(trimmed, "title");
		const href = attr(trimmed, "href");
		if (title) {
			return {
				kind: "open",
				line: `${indent}### ${href ? `[${title}](${href})` : title}`,
				selfClosing,
			};
		}
	}

	return wrappers.has(name) || titledBlocks.has(name)
		? { kind: "open", selfClosing }
		: undefined;
}

function stripIndexBanner(markdown: string) {
	return markdown.replace(
		/^> ## Documentation Index\n> Fetch the complete documentation index at: https?:\/\/\S+\n> Use this file to discover all available pages before exploring further\.\n\n?/,
		"",
	);
}

function stripComponentIndent(line: string, depth: number) {
	let stripped = line;
	for (let index = 0; index < depth && stripped.startsWith("  "); index++) {
		stripped = stripped.slice(2);
	}
	return stripped;
}

function openFence(line: string) {
	const match = line.match(/^(\s*)(`{3,}|~{3,})(.*)$/);
	if (!match) return undefined;

	const marker = match[2]![0] as "`" | "~";
	const length = match[2]!.length;
	const language = match[3]!.trim().match(/^([A-Za-z0-9_#+.-]+)/)?.[1] ?? "";
	return {
		line: `${match[1]}${match[2]}${language}`,
		fence: { marker, length },
	};
}

function closesFence(line: string, fence: Fence) {
	const trimmed = line.trim();
	return (
		trimmed.startsWith(fence.marker.repeat(fence.length)) &&
		[...trimmed].every((char) => char === fence.marker)
	);
}

function attr(tag: string, name: string) {
	const match = tag.match(new RegExp(`${name}\\s*=\\s*("[^"]*"|'[^']*')`));
	return match?.[1]?.slice(1, -1);
}
