export function whitespaceKey(value: string): string {
	return value.replace(/\s+/g, " ").trim();
}

export function uniqueByWhitespace(values: string[]): string[] {
	const seen = new Set<string>();
	return values.filter((value) => {
		const key = whitespaceKey(value);
		if (!key || seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

export function wordCount(value: string): number {
	return whitespaceKey(value).split(/\s+/).filter(Boolean).length;
}

export function hasMarkdownBody(markdown: string): boolean {
	const trimmed = markdown.trim();
	if (!trimmed) return false;
	if (!trimmed.startsWith("---")) return true;
	const end = trimmed.indexOf("\n---", 3);
	return end < 0 || trimmed.slice(end + 4).trim().length > 0;
}

export const invisibleTextPattern =
	"(?:\\u034f|\\p{Variation_Selector}|[\\u00ad\\u115f\\u1160\\u180e\\u200b-\\u200d\\u2060-\\u2064\\u2800\\u3164\\ufeff\\uffa0])";

const invisibleTextOnlyPattern = new RegExp(
	`^(?:\\s|${invisibleTextPattern})*$`,
	"u",
);

export function isInvisibleTextOnly(value: string) {
	return invisibleTextOnlyPattern.test(value);
}

export function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function safeDecode(value: string): string {
	try {
		return decodeURIComponent(value);
	} catch {
		return value;
	}
}

export function stripCompleteHtmlElement(
	html: string,
	tagName: string,
): string {
	const lower = html.toLowerCase();
	const openToken = `<${tagName}`;
	const closeToken = `</${tagName}>`;
	let out = "";
	let cursor = 0;
	let index = 0;
	while (index < html.length) {
		const start = lower.indexOf(openToken, index);
		if (start === -1) break;
		const afterName = start + openToken.length;
		if (!/[\s>/]/.test(lower[afterName] ?? "")) {
			index = afterName;
			continue;
		}
		const openEnd = html.indexOf(">", afterName);
		if (openEnd === -1) break;
		const end = lower.indexOf(closeToken, openEnd + 1);
		if (end === -1) break;
		out += html.slice(cursor, start);
		cursor = end + closeToken.length;
		index = cursor;
	}
	return cursor === 0 ? html : out + html.slice(cursor);
}
