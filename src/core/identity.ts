import { canonicalUrlSearch } from "./url.ts";

type IdentityInput = {
	url?: string;
	finalUrl?: string;
	canonicalUrl?: string;
	aliases?: string[];
};

export function identityKeys(input: IdentityInput): string[] {
	const keys = identityKeyGroups(input);
	return unique([...keys.exact, ...keys.route]);
}

export function identityKeyGroups(input: IdentityInput) {
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
	const primary = [input.url, input.finalUrl, ...(input.aliases ?? [])].filter(
		(value): value is string => Boolean(value),
	);
	const canonical = credibleCanonical(input.canonicalUrl, primary);
	return unique([...primary, ...(canonical ? [canonical] : [])]);
}

export function candidateKey(raw: string) {
	return routeKey(raw) ?? raw;
}

export function artifactUrl(raw: string): string | undefined {
	try {
		const url = new URL(raw);
		if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
		url.username = "";
		url.password = "";
		url.hash = "";
		return url.href;
	} catch {
		return undefined;
	}
}

function urlKey(raw: string) {
	const url = cleanUrl(raw);
	if (!url) return undefined;
	if (url.pathname !== "/") url.pathname = url.pathname.replace(/\/+$/, "");
	const query = canonicalUrlSearch(url);
	url.search = "";
	return `url:${url.href}${query}`;
}

function routeKey(raw: string) {
	const url = cleanUrl(raw);
	if (!url) return undefined;
	let path = url.pathname
		.replace(/%[0-9a-f]{2}/gi, (value) => value.toUpperCase())
		.replace(/\/+$/, "");
	path = path.replace(/\/index(?:\.(?:html?|mdx?|txt))?$/i, "");
	path = path.replace(/\.(?:html?|mdx?|md|txt)$/i, "");
	return `route:${url.origin}${path || "/"}${canonicalUrlSearch(url)}`;
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

function credibleCanonical(
	canonical: string | undefined,
	primaryUrls: string[],
) {
	if (!canonical) return undefined;
	if (primaryUrls.length === 0) return canonical;
	const canonicalRoute = routeKey(canonical);
	if (!canonicalRoute) return undefined;
	return primaryUrls.some((raw) => routeKey(raw) === canonicalRoute)
		? canonical
		: undefined;
}

function unique<T>(values: T[]): T[] {
	return [...new Set(values)];
}
