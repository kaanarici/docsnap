import { whitespaceKey } from "../core/text.ts";

export const pipeSet = (value: string) => new Set(value.split("|"));

const boilerplateLines = pipeSet(
	"advertisement|advertisements|accept all cookies|accept cookies|ask about this page|back to top|cookie policy|copy markdown|copy page|edit code|follow us|got it|install tools|manage cookies|menu|most popular|most read|newsletter|next example|open in chatgpt|open in claude|open in cursor|press enter to start editing|previous example|print this page|read more|related articles|related stories|share|share this|show less|show more|sign up|skip to content|skip to main content|sponsored|sponsored content|sponsored links|subscribe|tweet|view as markdown|we use cookies",
);
const articleFooterHeadings = pipeSet(
	"help improve mdn|related articles|related posts|related stories|written by",
);
const articleFooterLines = pipeSet(
	"is this helpful|is this helpful?|is this page helpful|is this page helpful?|related posts from|was this helpful|was this helpful?|was this page helpful|was this page helpful?",
);
const chromeLinkListLabels = pipeSet(
	"bundle size|feedback|figma|material design|sketch|source|view as markdown",
);
const standaloneEditLinkPattern =
	/^\[\[edit\]\([^)]*\baction=edit\b[^)]*\)\]$/i;
const docActionLinkLinePattern =
	/^(?:or )?(?:open in (?:chatgpt|claude|cursor)|report an issue|edit this page(?: on github)?)(?: or (?:open in (?:chatgpt|claude|cursor)|report an issue|edit this page(?: on github)?))*$/;
export function chromeKey(value: string): string {
	return whitespaceKey(value.replace(/[*_`]+/g, "")).toLowerCase();
}

export function isMarkdownChromeLine(line: string): boolean {
	const trimmed = line.trim();
	if (!trimmed) return false;
	if (standaloneEditLinkPattern.test(trimmed)) return true;
	if (isReadingTimeLine(trimmed)) return true;
	if (isShareListChromeLine(trimmed)) return true;
	if (isChromeLinkListLine(trimmed)) return true;
	if (isDocControlChromeLine(trimmed)) return true;
	if (isMarkdownStructuralLine(trimmed)) return false;
	return boilerplateLines.has(chromeKey(trimmed));
}

export function isArticleFooterStart(line: string) {
	const match = line.trim().match(/^#{2,3}\s+(.+)$/);
	return (
		Boolean(match && articleFooterHeadings.has(chromeKey(match[1]!))) ||
		articleFooterLines.has(chromeKey(line))
	);
}

function isReadingTimeLine(trimmed: string) {
	if (!trimmed.startsWith("|")) return false;
	if (trimmed.indexOf("|", 1) >= 0) return false;
	const text = chromeKey(trimmed.slice(1));
	return /^\d+\s+(?:min|mins|minute|minutes)(?:\s+read)?$/.test(text);
}

function isShareListChromeLine(trimmed: string) {
	return (
		/^[-*+] /.test(trimmed) &&
		["share:", "share this:"].includes(chromeKey(trimmed.slice(2)))
	);
}

function isChromeLinkListLine(trimmed: string) {
	const match = trimmed.match(/^[-*+]\s+\[([^\]]+)]\([^)]+\)\s*$/);
	return Boolean(match && chromeLinkListLabels.has(chromeKey(match[1]!)));
}

function isDocControlChromeLine(trimmed: string) {
	const key = chromeKey(trimmed.replace(/\[([^\]]+)]\([^)]+\)/g, " $1 "));
	if (docActionLinkLinePattern.test(key)) return true;
	if (key === "skip to content") return true;
	if (key === "copy pagecopy" || key === "copy as markdown copied!")
		return true;
	if (key.includes("select a language") && key.endsWith("no results"))
		return true;
	if (key.startsWith("this page is also available")) return true;
	if (/^for (?:a .* overview|an index) of all /.test(key)) return true;
	if (key.includes("features available in") && key.includes("latest version"))
		return true;
	return ["reloadclear", "reloadclearfork"].includes(key.replace(/\s+/g, ""));
}

function isMarkdownStructuralLine(trimmed: string): boolean {
	const first = trimmed[0];
	if (first === "#" || first === ">") return true;
	if ((first === "-" || first === "*" || first === "+") && trimmed[1] === " ") {
		return true;
	}
	return /^\d+[.)] /.test(trimmed);
}
