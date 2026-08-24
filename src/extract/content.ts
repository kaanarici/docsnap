import type { FetchResult } from "../core/types.ts";

const markdownContent = /markdown|mdx|text\/plain/i;
const structuredTextContent = /json|ya?ml|xml|toml/i;
const structuredTextPath = /\.(?:json|ya?ml|xml|toml)$/i;

export function isMarkdownLike(result: FetchResult): boolean {
	return (
		!hasHtmlMarkup(result.body) || markdownContent.test(result.contentType)
	);
}

export function isStructuredTextAsset(result: FetchResult): boolean {
	if (/xhtml/i.test(result.contentType)) return false;
	if (structuredTextContent.test(result.contentType)) return true;
	return (
		structuredTextPath.test(new URL(result.finalUrl).pathname) &&
		!hasHtmlMarkup(result.body)
	);
}

export function shouldExtractInWorker(result: FetchResult): boolean {
	return (
		result.ok &&
		(Boolean(result.document) ||
			(/<html[\s>]/i.test(result.body) &&
				!markdownContent.test(result.contentType) &&
				!structuredTextPath.test(new URL(result.finalUrl).pathname)))
	);
}

export function languageFromUrl(url: string): string {
	const extension = new URL(url).pathname
		.match(/\.(json|ya?ml|xml|toml)$/i)?.[1]
		?.toLowerCase();
	return extension === "yml" ? "yaml" : (extension ?? "");
}

function hasHtmlMarkup(body: string) {
	return /<\/?[a-z][\w:-]*(?:\s|>|\/>)/i.test(body);
}
