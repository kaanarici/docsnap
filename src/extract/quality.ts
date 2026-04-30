import { markdownLinkCount } from "../core/markdown.ts";
import { wordCount } from "../core/text.ts";

type MarkdownQuality = {
	confidence: number;
	reasons: string[];
};

export function scoreMarkdown(
	markdown: string,
	title?: string,
): MarkdownQuality {
	const words = wordCount(markdown);
	const headings = (markdown.match(/^#{1,6}\s+/gm) ?? []).length;
	const codeBlocks = (markdown.match(/```/g) ?? []).length / 2;
	const links = markdownLinkCount(markdown);
	const reasons: string[] = [];
	let score = 1;

	if (!title) {
		score -= 0.15;
		reasons.push("missing title");
	}
	if (words < 40) {
		score -= 0.35;
		reasons.push("thin content");
	}
	if (headings === 0) score -= 0.1;
	if (links > Math.max(20, words / 8)) {
		score -= 0.2;
		reasons.push("high link density");
	}
	if (codeBlocks % 1 !== 0) {
		score -= 0.1;
		reasons.push("unbalanced code fences");
	}
	return { confidence: Math.max(0, Number(score.toFixed(2))), reasons };
}
