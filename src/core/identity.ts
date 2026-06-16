import { safeDecode } from "./text.ts";

export type IdentityInput = {
	url?: string;
	finalUrl?: string;
	canonicalUrl?: string;
	aliases?: string[];
};

export function identityKeys(input: IdentityInput): string[] {
	const keys = identityKeyGroups(input);
	return unique([...keys.exact, ...keys.route]);
}

export function identityKeyGroups(input: IdentityInput): {
	exact: string[];
	route: string[];
} {
	const exact: string[] = [];
	const route: string[] = [];
	for (const raw of identityUrls(input)) {
		const url = urlKey(raw);
		const routeMatch = routeKey(raw);
		if (url) exact.push(url);
		if (routeMatch) route.push(routeMatch);
	}
	return { exact: unique(exact), route: unique(route) };
}

export function identityUrls(input: IdentityInput): string[] {
	return unique(
		[
			input.url,
			input.finalUrl,
			input.canonicalUrl,
			...(input.aliases ?? []),
		].filter((value): value is string => Boolean(value)),
	);
}

function urlKey(raw: string) {
	const url = cleanUrl(raw);
	if (!url) return undefined;
	if (url.pathname !== "/") url.pathname = url.pathname.replace(/\/+$/, "");
	const query = canonicalQuery(url);
	url.search = "";
	return `url:${url.href}${query}`;
}

function routeKey(raw: string) {
	const url = cleanUrl(raw);
	if (!url) return undefined;
	let path = safeDecode(url.pathname).replace(/\/+$/, "");
	path = path.replace(/\/index(?:\.(?:html?|mdx?|txt))?$/i, "");
	path = path.replace(/\.(?:html?|mdx?|txt)$/i, "");
	return `route:${url.origin}${path || "/"}${canonicalQuery(url)}`;
}

function cleanUrl(raw: string) {
	try {
		const url = new URL(raw);
		url.hash = "";
		return url;
	} catch {
		return undefined;
	}
}

// Query-addressed pages (e.g. ?version=2) are distinct content; fold a stable,
// order-independent query suffix into both keys so they neither over-merge with
// each other nor with the bare path. Query-free URLs keep the legacy bare keys
// so existing path-variant dedup (.html/.md/trailing-slash) is untouched.
function canonicalQuery(url: URL) {
	if (!url.search) return "";
	const params = [...url.searchParams.entries()].sort(([a], [b]) =>
		a < b ? -1 : a > b ? 1 : 0,
	);
	return `?${new URLSearchParams(params).toString()}`;
}

function unique<T>(values: T[]): T[] {
	return [...new Set(values)];
}
