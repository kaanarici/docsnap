import { markdownLinkCount } from "../core/markdown.ts";
import { wordCount } from "../core/text.ts";

export function qualityReasons(markdown: string, title?: string) {
	const words = wordCount(markdown);
	const codeBlocks = (markdown.match(/```/g) ?? []).length / 2;
	const links = markdownLinkCount(markdown);
	const reasons: string[] = [];

	if (!title) reasons.push("missing title");
	if (words < 40) {
		reasons.push("thin content");
	}
	if (links > Math.max(20, words / 8)) {
		reasons.push("high link density");
	}
	if (codeBlocks % 1 !== 0) {
		reasons.push("unbalanced code fences");
	}
	if (isUsefulShortPage(markdown, words, links, codeBlocks, Boolean(title))) {
		const thin = reasons.indexOf("thin content");
		if (thin >= 0) reasons.splice(thin, 1);
	}
	return reasons;
}

export function isLowQuality(reasons: readonly string[]) {
	return (
		reasons.includes("thin content") || reasons.includes("truncated extraction")
	);
}

function isUsefulShortPage(
	markdown: string,
	words: number,
	links: number,
	codeBlocks: number,
	hasTitle: boolean,
) {
	return (
		(codeBlocks >= 1 && words >= 12 && markdown.length >= 160) ||
		(links >= 5 && words >= 8 && markdown.length >= 400) ||
		(links >= 1 &&
			words >= 14 &&
			markdown.length >= 170 &&
			/[.!?]\s/.test(markdown)) ||
		(hasTitle &&
			words >= 10 &&
			markdown.length >= 80 &&
			(links > 0 || /[.!?]/.test(markdown)))
	);
}
