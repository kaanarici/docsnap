import type { FetchResult } from "../core/types.ts";

export function refreshUrl(result: FetchResult): string | undefined {
	if (!result.ok || !/html/i.test(result.contentType)) return undefined;
	const html = stripCompleteHtmlElement(result.body, "noscript");
	const match = html.match(
		/<meta\b[^>]*http-equiv\s*=\s*["']?\s*refresh\s*["']?[^>]*>/i,
	);
	const target =
		refreshTarget(attributeValue(match?.[0], "content")) ??
		scriptRedirectTarget(html);
	if (!target) return undefined;
	try {
		const url = new URL(target.replace(/^['"]|['"]$/g, ""), result.finalUrl);
		url.hash = "";
		return url.href;
	} catch {
		return undefined;
	}
}

function stripCompleteHtmlElement(html: string, tagName: string): string {
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
		if (!tagNameBoundary(lower[afterName])) {
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

function tagNameBoundary(char: string | undefined) {
	return char === undefined || /[\s>/]/.test(char);
}

function refreshTarget(content: string | undefined): string | undefined {
	const explicit = content?.match(/(?:^|;)\s*url\s*=\s*(.+)\s*$/i)?.[1];
	if (explicit?.trim()) return explicit.trim();
	const implicit = content?.split(";").slice(1).join(";").trim();
	return implicit || undefined;
}

function attributeValue(
	tag: string | undefined,
	name: string,
): string | undefined {
	if (!tag) return undefined;
	const pattern = new RegExp(
		`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`,
		"i",
	);
	const match = tag.match(pattern);
	return match?.[1] ?? match?.[2] ?? match?.[3];
}

function scriptRedirectTarget(html: string): string | undefined {
	if (!/redirect(?:ing|ed(?: automatically)?)/i.test(html)) return undefined;
	const variables = new Map<string, string>();
	for (const match of html.matchAll(
		/(?:\b(?:const|let|var)\b|[,;])\s*([A-Za-z_$][\w$]*)\s*=\s*["']([^"']+)["']/g,
	)) {
		variables.set(match[1]!, match[2]!);
	}
	for (const match of html.matchAll(/location\.replace\(([^)]{1,240})/g)) {
		const target = evaluateStringExpression(match[1]!, variables);
		if (target) return target;
	}
	let assignment: string | undefined;
	for (const match of html.matchAll(
		/(?:window\.)?location(?:\.href)?\s*=\s*([^;\n]{1,240})/g,
	)) {
		assignment = evaluateStringExpression(match[1]!, variables) ?? assignment;
	}
	return assignment;
}

function evaluateStringExpression(
	expression: string,
	variables: Map<string, string>,
): string | undefined {
	let out = "";
	for (const part of expression.split("+")) {
		const token = part.trim();
		const literal = token.match(/^["']([^"']*)["']$/)?.[1];
		if (literal !== undefined) {
			out += literal;
			continue;
		}
		const template = token.match(/^`([^`$]*)`$/)?.[1];
		if (template !== undefined) {
			out += template;
			continue;
		}
		const variable = token.match(/^[A-Za-z_$][\w$]*$/)?.[0];
		if (variable && variables.has(variable)) {
			out += variables.get(variable);
			continue;
		}
		if (/^(?:window\.)?location\.(?:search|hash)$/.test(token)) continue;
		return undefined;
	}
	return out;
}
