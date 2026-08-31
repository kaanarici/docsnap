import { safeDecode } from "../core/text.ts";

const genericTitles = new Set([
	"docs",
	"documentation",
	"developer docs",
	"developer documentation",
	"api reference",
	"home",
]);

export function titleFromMarkdown(markdown: string, fallback: string): string {
	return (
		cleanTitle(firstMarkdownHeading(markdown, 1) ?? slugTitle(fallback)) ??
		fallback
	);
}

export function titleFromContent(
	markdown: string,
	fallback?: string,
): string | undefined {
	const title = cleanTitle(fallback);
	return (
		firstMarkdownHeading(markdown, 1) ?? title ?? firstMarkdownHeading(markdown)
	);
}

function cleanTitle(value: string | undefined): string | undefined {
	return (
		value
			?.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
			.replace(/[`*_]+/g, "")
			?.replace(/\s*¶\s*$/u, "")
			.replace(/([a-z])((?:Deprecated|Beta|Preview))$/u, "$1 $2")
			.trim() || undefined
	);
}

function firstMarkdownHeading(markdown: string, exactLevel?: number) {
	for (const line of markdown.split(/\n/)) {
		const match = /^(#{1,3})\s+(.+)$/.exec(line);
		if (!match || (exactLevel && match[1]!.length !== exactLevel)) continue;
		const title = cleanTitle(match[2]);
		if (title && !genericTitle(title)) return title;
	}
	return undefined;
}

function genericTitle(value: string) {
	const title = value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, " ")
		.trim();
	return genericTitles.has(title) || /^[a-z0-9_.-]+ docs?$/.test(title);
}

function slugTitle(value: string) {
	const path = urlPath(value) ?? value.split(/[?#]/)[0] ?? value;
	const parts = path.split("/").filter(Boolean);
	const last = parts.at(-1);
	const name = (
		last?.replace(/\.(?:mdx?|html?|txt)$/i, "") === "index"
			? parts.at(-2)
			: last
	)?.replace(/\.(?:mdx?|html?|txt)$/i, "");
	return name
		? safeDecode(name)
				.replace(/[-_]+/g, " ")
				.replace(/\b\w/g, (char) => char.toUpperCase())
		: undefined;
}

function urlPath(value: string) {
	try {
		return new URL(value, "https://docsnap.invalid").pathname;
	} catch {
		return undefined;
	}
}
