import type { FetchResult } from "../core/types.ts";

const markdownContent = /markdown|mdx|text\/plain/i;
const structuredTextContent = /json|ya?ml|xml|toml/i;
const structuredTextPath = /\.(?:json|ya?ml|xml|toml)$/i;
const codeTextContent =
	/(?:javascript|typescript|ecmascript|css|shellscript|x-sh|python|x-python|x-sql|sql)/i;
const codeTextPath =
	/\.(?:bash|c|cjs|cpp|css|fish|go|h|hpp|java|js|jsx|kt|kts|mjs|php|py|rb|rs|sh|sql|swift|ts|tsx|zsh)$/i;

export function isMarkdownLike(result: FetchResult): boolean {
	return (
		(!isCodeTextAsset(result) && !hasHtmlMarkup(result.body)) ||
		markdownContent.test(result.contentType)
	);
}

export function isCodeTextAsset(result: FetchResult): boolean {
	return (
		codeTextContent.test(result.contentType) ||
		(!/html/i.test(result.contentType) &&
			codeTextPath.test(new URL(result.finalUrl).pathname))
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
		.match(
			/\.(bash|c|cjs|cpp|css|fish|go|h|hpp|java|js|json|jsx|kt|kts|mjs|php|py|rb|rs|sh|sql|swift|toml|ts|tsx|xml|ya?ml|zsh)$/i,
		)?.[1]
		?.toLowerCase();
	if (extension === "yml") return "yaml";
	if (["bash", "fish", "sh", "zsh"].includes(extension ?? "")) return "bash";
	if (["cjs", "js", "mjs"].includes(extension ?? "")) return "javascript";
	if (["kt", "kts"].includes(extension ?? "")) return "kotlin";
	if (extension === "py") return "python";
	if (extension === "rb") return "ruby";
	if (extension === "rs") return "rust";
	if (extension === "ts") return "typescript";
	return extension ?? "";
}

export function languageFromContentType(contentType: string): string {
	const type = contentType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
	if (/shellscript|x-sh/.test(type)) return "bash";
	if (/javascript|ecmascript/.test(type)) return "javascript";
	if (/typescript/.test(type)) return "typescript";
	if (/css/.test(type)) return "css";
	if (/python|x-python/.test(type)) return "python";
	if (/sql/.test(type)) return "sql";
	return "";
}

function hasHtmlMarkup(body: string) {
	return /<\/?[a-z][\w:-]*(?:\s|>|\/>)/i.test(body);
}
