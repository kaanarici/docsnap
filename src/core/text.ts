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

// escape regex metacharacters so untrusted text is matched literally — never
// build a RegExp from raw URL/DOM input (catastrophic-backtracking ReDoS)
export function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
