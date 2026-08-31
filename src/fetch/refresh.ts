import { stripCompleteHtmlElement } from "../core/text.ts";
import type { FetchResult } from "../core/types.ts";

export function refreshUrl(result: FetchResult): string | undefined {
	if (!result.ok || !/html/i.test(result.contentType)) return undefined;
	const html = stripCompleteHtmlElement(
		result.body.slice(0, 131_072),
		"noscript",
	);
	const match = html.match(
		/<meta\b[^>]*http-equiv\s*=\s*["']?\s*refresh\s*["']?[^>]*>/i,
	);
	const content = match?.[0].match(
		/\bcontent\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i,
	);
	const target =
		refreshTarget(content?.[1] ?? content?.[2] ?? content?.[3]) ??
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

function refreshTarget(content: string | undefined): string | undefined {
	const explicit = content?.match(/(?:^|;)\s*url\s*=\s*(.+)\s*$/i)?.[1];
	if (explicit?.trim()) return explicit.trim();
	const implicit = content?.split(";").slice(1).join(";").trim();
	return implicit || undefined;
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
