export function whitespaceKey(value: string): string {
	return value.replace(/\s+/g, " ").trim();
}

export function uniqueByWhitespace(values: string[]): string[] {
	const seen = new Set<string>();
	return values.filter((value) => {
		const key = whitespaceKey(value);
		if (!key || seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

export function wordCount(value: string): number {
	return whitespaceKey(value).split(/\s+/).filter(Boolean).length;
}
