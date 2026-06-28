export function citationId(
	outputPath: string,
	lineStart: number,
	lineEnd: number,
	contentHash: string,
): string {
	const hash = contentHash ? `@${contentHash.slice(0, 12)}` : "";
	return `${outputPath}#L${lineStart}-L${lineEnd}${hash}`;
}
