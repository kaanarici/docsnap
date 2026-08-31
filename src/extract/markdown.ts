import { replaceMarkdownLinks } from "../core/markdown.ts";
import {
	invisibleTextPattern,
	isInvisibleTextOnly,
	wordCount,
} from "../core/text.ts";
import {
	chromeKey,
	isArticleFooterStart,
	isMarkdownChromeLine,
	pipeSet,
} from "./markdown-chrome.ts";
export function cleanMarkdown(markdown: string): string {
	let fence: Fence | undefined;
	let pendingFenceLanguage = "";
	let componentDepth = 0;
	let bodyWords = 0;
	let skippedSphinxPermalink = false;
	const lines: string[] = [];
	const sourceLines = stripIndexBanner(stripSourceFrontmatter(markdown)).split(
		"\n",
	);

	for (let index = 0; index < sourceLines.length; index++) {
		const rawLine = sourceLines[index]!;
		const line = stripComponentIndent(rawLine, componentDepth);
		if (fence) {
			const finalLine = line.replace(invisibleTextRunPattern, "");
			lines.push(finalLine);
			bodyWords += wordCount(finalLine);
			if (closesFence(line, fence)) fence = undefined;
			continue;
		}
		const component = componentLine(line);
		if (component) {
			if (component.kind === "close")
				componentDepth = Math.max(0, componentDepth - 1);
			if (component.kind === "open") {
				if (component.line !== undefined) {
					lines.push(component.line);
					bodyWords += wordCount(component.line);
				}
				if (!component.selfClosing) componentDepth++;
			}
			continue;
		}

		const opened = openFence(line);
		if (opened) {
			fence = opened.fence;
			lines.push(
				pendingFenceLanguage && fenceHasNoLanguage(opened.line)
					? `${opened.line}${pendingFenceLanguage}`
					: opened.line,
			);
			pendingFenceLanguage = "";
			continue;
		}

		const rawCleanedLine = stripInvisibleAnchorLinks(
			cleanMarkdownLine(line),
		).replace(/^(#{1,6})[ \t]{2,}/, "$1 ");
		const trimmedLine = rawCleanedLine.trim();
		if (/^#{1,6}$/.test(trimmedLine)) continue;
		if (sphinxPermalinkLinePattern.test(trimmedLine)) {
			skippedSphinxPermalink = true;
			continue;
		}
		if (skippedSphinxPermalink) {
			if (!trimmedLine) continue;
			skippedSphinxPermalink = false;
		}
		if (horizontalRuleLinePattern.test(trimmedLine)) continue;
		const cleanedLine = stripSphinxPermalinks(rawCleanedLine);
		if (isArticleFooterStart(cleanedLine) && bodyWords >= 80) break;
		if (isMarkdownChromeLine(cleanedLine)) continue;
		const finalLine = cleanedLine.replace(invisibleTextRunPattern, "");
		const fenceHint = codeFenceHint(finalLine);
		if (
			fenceHint &&
			nextMeaningfulLineOpensFence(sourceLines, index, componentDepth)
		) {
			pendingFenceLanguage = fenceHint.language;
			if (fenceHint.keepLine) {
				lines.push(finalLine);
				bodyWords += wordCount(finalLine);
			}
			continue;
		}
		const linkBlocks = standaloneLinkBlocks(finalLine);
		if (linkBlocks) {
			lines.push(...linkBlocks);
			bodyWords += linkBlocks.reduce((sum, block) => sum + wordCount(block), 0);
		} else {
			lines.push(finalLine);
			bodyWords += wordCount(finalLine);
		}
	}

	const cleaned = dropTrailingSchemaJsonFence(
		lines
			.join("\n")
			.replace(/\n{3,}/g, "\n\n")
			.trim(),
	);
	return normalizeImageAlt(
		repairBrokenLinkBlocks(repairSphinxSignatureEmphasis(cleaned)),
	);
}

function standaloneLinkBlocks(line: string) {
	if (
		!/^\s*\[[^\]]+]\([^)\n]+\)(?:\s+\[[^\]]+]\([^)\n]+\)){1,}\s*$/.test(line)
	) {
		return undefined;
	}
	return line
		.trim()
		.split(/\s+(?=\[[^\]]+]\()/)
		.map((link) => `- ${link}`);
}

const sphinxPermalinkLinePattern = /^\[¶]\([^)]+\)$/;
const horizontalRuleLinePattern = /^(?:-{3,}|\*{3,}|_{3,})$/;

function stripSphinxPermalinks(line: string) {
	return line.replace(/\[¶]\([^)]+\)/g, "").trimEnd();
}

function repairSphinxSignatureEmphasis(markdown: string) {
	const lines = markdown.split("\n");
	for (let index = 0; index + 3 < lines.length; index++) {
		if (
			lines[index]?.startsWith("**") &&
			!lines[index]?.endsWith("**") &&
			lines[index + 1] === "" &&
			lines[index + 2] === "**" &&
			lines[index + 3]?.startsWith(":")
		) {
			lines[index] += "**";
			lines.splice(index + 1, 2);
		}
	}
	return lines.join("\n");
}

function repairBrokenLinkBlocks(markdown: string) {
	return markdown
		.replace(/^(#{1,6}\s+[^\n[]+)(\[[^\]]+]\()/gm, "$1\n\n$2")
		.replace(
			/\[\n+\s*([^\][][\s\S]{0,500}?[^\][])\s*\n+\]\(([^)\n]+)\)/g,
			(_, text: string, href: string) =>
				`[${text.replace(/\s+/g, " ").trim()}](${href})`,
		)
		.replace(/(\]\([^)]+\))(?=\[)/g, "$1\n\n");
}

const codeFenceLanguageNames = pipeSet(
	"bash|c|csharp|css|go|html|java|javascript|json|js|jsx|kotlin|markdown|php|python|ruby|rust|sql|swift|tsx|typescript|yaml",
);

function codeFenceHint(line: string) {
	const trimmed = line.trim();
	if (trimmed.length > 24 || /[\s`()[\]{}:;]/.test(trimmed)) return "";
	const key = chromeKey(trimmed);
	if (key === "cli" || key === "curl" || key === "shell") {
		return { language: "bash", keepLine: false };
	}
	if (codeFenceLanguageNames.has(key)) {
		return { language: key, keepLine: false };
	}
	const fileLanguage = filenameCodeLanguage(key);
	return fileLanguage ? { language: fileLanguage, keepLine: true } : "";
}

const filenameCodeLanguages = new Map<string, string>(
	"cjs:javascript|css:css|go:go|htm:html|html:html|java:java|js:javascript|json:json|jsx:jsx|kt:kotlin|md:markdown|mdx:markdown|mjs:javascript|php:php|py:python|rb:ruby|rs:rust|sh:bash|sql:sql|swift:swift|ts:typescript|tsx:tsx|yaml:yaml|yml:yaml"
		.split("|")
		.map((pair) => {
			const [extension = "", language = ""] = pair.split(":");
			return [extension, language] as const;
		}),
);

function filenameCodeLanguage(key: string) {
	const match = key.match(/^[a-z0-9_.-]+\.([a-z0-9]+)$/);
	return match ? filenameCodeLanguages.get(match[1]!) : undefined;
}

function nextMeaningfulLineOpensFence(
	sourceLines: string[],
	index: number,
	componentDepth: number,
) {
	for (let cursor = index + 1; cursor < sourceLines.length; cursor++) {
		const line = cleanMarkdownLine(
			stripComponentIndent(sourceLines[cursor]!, componentDepth),
		).trim();
		if (!line) continue;
		const fence = openFence(line);
		return Boolean(fence && fenceHasNoLanguage(fence.line));
	}
	return false;
}

function fenceHasNoLanguage(line: string) {
	return /^(?:\s*)(?:`{3,}|~{3,})$/.test(line);
}

function stripHeadingControlSuffix(line: string): string {
	const match = line.match(
		/^(\s*#{1,6}\s+)(.+?)(?:\s*(?:Expand\s+Collapse|Expand\s+All|Collapse\s+All))\s*$/i,
	);
	return match ? `${match[1]}${match[2]!.trimEnd()}` : line;
}

function cleanMarkdownLine(line: string) {
	const image = markdownImageLine(line);
	if (image !== undefined) return image;
	return stripSelfLinkedHeading(stripHeadingControlSuffix(line))
		.replace(/<\/?([A-Z][A-Za-z0-9]*)(?:\s[^>]*)?>/g, (match, name: string) =>
			name === "CodeStep" ? "" : match,
		)
		.replace(
			/^\s*<\/?(?:svg|path|g|defs|clipPath|rect|circle|line|polyline|polygon|use|source|picture)(?:\s[^>]*)?\/?>\s*$/i,
			"",
		)
		.replace(/(`+|\]\([^)]+\)) +([,.;:!?])/g, "$1$2")
		.replace(/\s*\{\/\*.*?\*\/}\s*/g, " ")
		.trimEnd();
}

function stripSelfLinkedHeading(line: string): string {
	const match = line.match(/^(#{1,6}\s+)\[([^\]]+)]\(([^)]+)\)(.*)$/);
	if (!match || !localHeadingHref(match[3]!)) return line;
	return `${match[1]}${match[2]}${match[4]}`;
}

function stripInvisibleAnchorLinks(markdown: string) {
	if (!invisibleAnchorLinkPattern.test(markdown)) return markdown;
	return replaceMarkdownLinks(markdown, (link) =>
		isInvisibleTextOnly(link.text) && localAnchorHref(link.href)
			? ""
			: undefined,
	);
}

function localAnchorHref(href: string) {
	return href.includes("#") && !href.includes(":") && !href.startsWith("//");
}

function localHeadingHref(href: string) {
	return (
		!href.includes(":") &&
		!href.startsWith("//") &&
		(href.startsWith("#") || href.startsWith("./") || href.startsWith("../"))
	);
}

const invisibleTextRunPattern = new RegExp(`${invisibleTextPattern}+`, "gu");
const invisibleAnchorLinkPattern = new RegExp(
	`\\[(?:\\s|${invisibleTextPattern})*\\]\\(`,
	"u",
);

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
		const alt = markdown.slice(altStart, altEnd);
		out += isUrlImageAlt(alt, markdown.slice(altEnd + 2, srcEnd))
			? ""
			: cappedAlt(alt);
		out += markdown.slice(altEnd, srcEnd + 1);
		cursor = srcEnd + 1;
	}
	return out;
}

function isUrlImageAlt(alt: string, src: string) {
	const text = alt.replace(/\s+/g, " ").trim();
	return Boolean(
		text && (/^(?:https?:)?\/\//i.test(text) || text === src.trim()),
	);
}

function cappedAlt(alt: string): string {
	if (alt.length <= 250 && !/\n|\s\s/.test(alt)) return alt;
	const collapsed = alt.replace(/\s+/g, " ").trim();
	return collapsed.length > 250 ? `${collapsed.slice(0, 249)}…` : collapsed;
}

type Fence = { marker: "`" | "~"; length: number };
type ComponentLine =
	| { kind: "close" | "drop" }
	| { kind: "open"; line?: string; selfClosing: boolean };

const wrappers = pipeSet(
	"AccordionGroup|CardGroup|CodeDiagram|CodeGroup|ConsoleBlock|ConsoleBlockMulti|ConsoleLogLine|DeepDive|Diagram|DiagramGroup|Frame|FullWidth|Info|Intro|InlineToc|Note|Pitfall|Recipes|RSC|Sandpack|Solution|Steps|Tabs|Tip|Warning|YouWillLearn",
);
const titledBlocks = pipeSet("Accordion|Card|Step|Tab");

function componentLine(line: string): ComponentLine | undefined {
	const indent = line.match(/^\s*/)?.[0] ?? "";
	if (indent.length > 3) return undefined;

	const trimmed = line.trim();
	if (/^<iframe\b[^>]*\/?>$/i.test(trimmed)) return { kind: "drop" };

	const tag = trimmed.match(/^<\/?([A-Z][A-Za-z0-9]*)(?:\s[^>]*)?>$/);
	if (!tag) return undefined;

	const name = tag[1]!;
	const wrapped = wrappers.has(name) || titledBlocks.has(name);
	if (!wrapped) return undefined;
	if (trimmed.startsWith("</")) return { kind: "close" };

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

	return { kind: "open", selfClosing };
}

function stripIndexBanner(markdown: string) {
	const lines = markdown.split("\n");
	let offset = 0;
	while (lines[offset]?.trim() === "") offset++;
	const banner = lines
		.slice(offset, offset + 3)
		.map((line) => chromeKey(line.replace(/^>\s*/, "")));
	if (
		banner[0] === "documentation index" &&
		banner[1]?.startsWith("fetch the complete documentation index at: ") &&
		banner[2] ===
			"use this file to discover all available pages before exploring further."
	) {
		return lines.slice(nextBodyLine(lines, offset + 3)).join("\n");
	}
	if (
		/^>\s*For an index of all .+ documentation, see \[[^\]]+]\([^)]+\)\.?$/i.test(
			lines[offset]?.trim() ?? "",
		)
	) {
		return lines.slice(nextBodyLine(lines, offset + 1)).join("\n");
	}
	return markdown;
}

function nextBodyLine(lines: string[], start: number) {
	while (lines[start]?.trim() === "") start++;
	return start;
}
function stripSourceFrontmatter(markdown: string) {
	if (!markdown.startsWith("---\n")) return markdown;
	const close = markdown.indexOf("\n---", 4);
	if (close < 0) return markdown;
	const after = close + 4;
	if (markdown[after] && markdown[after] !== "\n" && markdown[after] !== "\r") {
		return markdown;
	}
	return markdown.slice(after).replace(/^\r?\n/, "");
}

function stripComponentIndent(line: string, depth: number) {
	let stripped = line;
	while (depth-- > 0 && stripped.startsWith("  ")) stripped = stripped.slice(2);
	return stripped;
}

type OpenFence = { line: string; fence: Fence };

function openFence(line: string): OpenFence | undefined {
	const match = line.match(/^(\s*)(`{3,}|~{3,})(.*)$/);
	if (!match) return undefined;

	const fence = match[2] ?? "";
	const marker = fence[0];
	if (marker !== "`" && marker !== "~") return undefined;
	const length = fence.length;
	if (marker === "`" && match[3]!.includes("`")) return undefined;
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

function markdownImageLine(line: string) {
	const match = line.match(/^(\s*)<img\b([^>]*)\/?>\s*$/i);
	if (!match) return undefined;
	const src = attr(match[2]!, "src");
	if (!src) return "";
	const alt = attr(match[2]!, "alt") ?? attr(match[2]!, "title") ?? "";
	return `${match[1]}![${alt.replace(/[[\]]/g, "")}](${src})`;
}

function dropTrailingSchemaJsonFence(markdown: string) {
	const lines = markdown.split("\n");
	let end = lines.length - 1;
	while (end >= 0 && lines[end]?.trim() === "") end--;
	if (end < 0 || lines[end]?.trim() !== "```") return markdown;
	let start = end - 1;
	while (start >= 0 && lines[start]?.trim() !== "```json") start--;
	if (start < 0) return markdown;
	const body = lines.slice(start + 1, end).filter((line) => line.trim());
	const schemaJson =
		body.length > 0 &&
		body.every((line) => {
			const trimmed = line.trim();
			return (
				trimmed.startsWith("{") &&
				trimmed.endsWith("}") &&
				/"@context"\s*:\s*"https:\/\/schema\.org"/.test(trimmed)
			);
		});
	return schemaJson ? lines.slice(0, start).join("\n").trimEnd() : markdown;
}
