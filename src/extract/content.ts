import type { FetchResult } from "../core/types.ts";

const markdownContent = /markdown|mdx|text\/plain/i;
const structuredTextContent = /json|ya?ml|xml|toml/i;
const structuredTextPath = /\.(json|ya?ml|xml|toml)$/i;

export function isMarkdownLike(result: FetchResult): boolean {
	return (
		!hasHtmlMarkup(result.body) || markdownContent.test(result.contentType)
	);
}

export function isStructuredTextAsset(result: FetchResult): boolean {
	return (
		!hasHtmlMarkup(result.body) &&
		(structuredTextContent.test(result.contentType) ||
			structuredTextPath.test(new URL(result.finalUrl).pathname))
	);
}

export function shouldExtractInWorker(result: FetchResult): boolean {
	return (
		result.ok &&
		/<html[\s>]/i.test(result.body) &&
		!markdownContent.test(result.contentType) &&
		!structuredTextPath.test(new URL(result.finalUrl).pathname)
	);
}

export function languageFromUrl(url: string): string {
	const pathname = new URL(url).pathname;
	if (/\.ya?ml$/i.test(pathname)) return "yaml";
	if (/\.json$/i.test(pathname)) return "json";
	if (/\.xml$/i.test(pathname)) return "xml";
	if (/\.toml$/i.test(pathname)) return "toml";
	return "";
}

function hasHtmlMarkup(body: string) {
	return /<\/?[a-z][\w:-]*(\s|>|\/>)/i.test(body);
}
