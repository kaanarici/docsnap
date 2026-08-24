import { captureSelectionTerms } from "../core/config.ts";
import type { PipelineConfig } from "../core/types.ts";
import { isLlmsResourcePath } from "../core/url.ts";
import { pathInScope } from "./url.ts";

export function candidateWindow(
	config: PipelineConfig,
	limit = config.max,
): number {
	if (!config.maxExplicit) return limit;
	return Math.max(limit * 4, 32);
}

export function orderByTopic(
	items: string[],
	seed: string,
	scope: string,
	intent?: string,
) {
	const intentTokens = new Set(captureSelectionTerms(intent));
	return items
		.map((item, index) => ({
			item,
			index,
			score: topicScore(item, seed, scope, intentTokens),
		}))
		.sort((a, b) => a.score - b.score || a.index - b.index)
		.map(({ item }) => item);
}

function topicScore(
	raw: string,
	seed: string,
	scope: string,
	intentTokens: Set<string>,
) {
	try {
		const url = new URL(raw);
		const base = new URL(seed);
		const penalty =
			(isLlmsResourcePath(url.pathname) ? 40 : 0) +
			(lowValuePath(url.pathname) ? 20 : 0);
		if (url.href === base.href) return -1_000 + penalty;
		const commonBonus = commonSegments(url.pathname, base.pathname) * 4;
		const topic = topicPrefix(base.pathname);
		const topicBonus = sharedTopicTokenCount(url.pathname, base.pathname) * 4;
		const intentBonus = sharedTokenCount(url.pathname, intentTokens) * 20;
		if (url.origin !== base.origin)
			return 200 - commonBonus + penalty - intentBonus;
		if (pathInScope(url.pathname, topic))
			return 10 - commonBonus + penalty - topicBonus - intentBonus;
		if (pathInScope(url.pathname, parentScope(base.pathname)))
			return 20 - commonBonus + penalty - topicBonus - intentBonus;
		if (pathInScope(url.pathname, scope))
			return 60 - commonBonus + penalty - topicBonus - intentBonus;
		return 100 - commonBonus + penalty - topicBonus - intentBonus;
	} catch {
		return 1_000;
	}
}

function sharedTokenCount(pathname: string, intentTokens: Set<string>) {
	if (intentTokens.size === 0) return 0;
	const pathTokens = new Set(captureSelectionTerms(pathname));
	let count = 0;
	for (const token of intentTokens) if (pathTokens.has(token)) count++;
	return count;
}
function topicPrefix(pathname: string) {
	if (pathname.endsWith("/")) return pathname;
	if (/\.[a-z0-9]+$/i.test(pathname))
		return pathname.replace(/\/[^/]*$/, "/") || "/";
	return `${pathname.replace(/\/+$/, "")}/`;
}

function parentScope(pathname: string) {
	if (pathname === "/") return "/";
	return pathname.replace(/\/?[^/]*$/, "/") || "/";
}

function commonSegments(a: string, b: string) {
	const left = a.split("/").filter(Boolean);
	const right = b.split("/").filter(Boolean);
	let count = 0;
	while (left[count] && left[count] === right[count]) count++;
	return count;
}

function sharedTopicTokenCount(pathname: string, seedPathname: string) {
	const seed = topicTokenSegments(seedPathname).at(-1);
	if (!seed) return 0;
	const tokens = new Set(topicTokenSegments(pathname).flat());
	return seed.filter((token) => tokens.has(token)).length;
}

function topicTokenSegments(pathname: string) {
	return pathname
		.replace(/\.(?:html?|mdx?|txt)$/i, "")
		.split("/")
		.filter(Boolean)
		.map((part) =>
			part
				.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
				.toLowerCase()
				.split(/[^a-z0-9]+/)
				.filter((token) => token.length > 1),
		);
}

function lowValuePath(pathname: string) {
	return /(?:^|\/)(?:widgets?|playground|chat|search)(?:\/|$)/i.test(pathname);
}
