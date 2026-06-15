import { safeDecode } from "./text.ts";
import { dropFragmentAndQuery } from "./url.ts";

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
	return `url:${url.href}`;
}

function routeKey(raw: string) {
	const url = cleanUrl(raw);
	if (!url) return undefined;
	let path = safeDecode(url.pathname).replace(/\/+$/, "");
	path = path.replace(/\/index(?:\.(?:html?|mdx?|txt))?$/i, "");
	path = path.replace(/\.(?:html?|mdx?|txt)$/i, "");
	return `route:${url.origin}${path || "/"}`;
}

function cleanUrl(raw: string) {
	try {
		return dropFragmentAndQuery(new URL(raw));
	} catch {
		return undefined;
	}
}

function unique<T>(values: T[]): T[] {
	return [...new Set(values)];
}
