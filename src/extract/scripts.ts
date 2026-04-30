import { uniqueByWhitespace, whitespaceKey, wordCount } from "../core/text.ts";

type TextCandidate = {
	value: string;
	weight: number;
};

const maxDepth = 2;

export function extractSerializedText(
	html: string,
	title: string | undefined,
): string | undefined {
	const candidates: TextCandidate[] = [];
	const titleKey = title ? whitespaceKey(title) : "";
	for (const body of scriptBodies(html)) {
		collectText(body, candidates, 0);
	}
	const segments = uniqueByWhitespace(
		candidates
			.sort((a, b) => b.weight - a.weight)
			.map((candidate) => candidate.value)
			.filter((value) => whitespaceKey(value) !== titleKey && readable(value)),
	)
		.map(whitespaceKey)
		.slice(0, 160);
	if (wordCount(segments.join(" ")) < 40) return undefined;
	return [title ? `# ${title}` : undefined, ...segments]
		.filter(Boolean)
		.join("\n\n");
}

function scriptBodies(html: string): string[] {
	const bodies: string[] = [];
	for (const match of html.matchAll(
		/<script\b(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi,
	)) {
		const body = match[1]?.trim();
		if (body) bodies.push(body);
	}
	return bodies;
}

function collectText(body: string, out: TextCandidate[], depth: number): void {
	for (const value of keyedStrings(body)) {
		out.push({ value, weight: 2 });
		if (depth < maxDepth && value.includes("\\"))
			collectText(value, out, depth + 1);
	}
	for (const value of stringLiterals(body)) {
		if (value.length > 500 && depth < maxDepth) {
			collectText(value, out, depth + 1);
			continue;
		}
		out.push({ value, weight: 1 });
	}
}

function keyedStrings(body: string): string[] {
	const values: string[] = [];
	for (const key of ["children", "description", "title"]) {
		const pattern = new RegExp(`"${key}"\\s*:\\s*("(?:\\\\.|[^"\\\\])*")`, "g");
		for (const match of body.matchAll(pattern)) {
			const value = decodeLiteral(match[1]!);
			if (value) values.push(value);
		}
	}
	return values;
}

function stringLiterals(body: string): string[] {
	const values: string[] = [];
	for (const match of body.matchAll(/"(?:\\.|[^"\\])*"/g)) {
		const value = decodeLiteral(match[0]);
		if (value) values.push(value);
	}
	return values;
}

function decodeLiteral(literal: string): string {
	try {
		const parsed = JSON.parse(literal);
		return typeof parsed === "string" ? parsed.trim() : "";
	} catch {
		return "";
	}
}

function readable(value: string): boolean {
	const text = whitespaceKey(value);
	if (text.length < 3 || text.length > 1_200) return false;
	if (!/[A-Za-z]{2}/.test(text)) return false;
	if (!text.includes(" ")) return false;
	if (/^(https?:|\/|#|\$|[a-z]+-[a-z0-9-]+$)/i.test(text)) return false;
	if (/^[A-Z0-9_.$:-]+$/.test(text)) return false;
	if (/^[a-z0-9_-]{12,}$/i.test(text)) return false;
	if ((text.match(/,/g) ?? []).length >= 5) return false;
	if (text.includes("__")) return false;
	if (/^(?:\d+\s*)+\d+px(?:\s+\d+)*$/i.test(text)) return false;
	if (/\.(?:css|js|mjs|woff2?|png|jpe?g|webp|svg)(?:\?|$)/i.test(text))
		return false;
	if (/[{};]/.test(text)) return false;
	if (utilityTokenCount(text) >= 3) return false;
	if (
		/\b(viewport|theme-color|max-image-preview|shortcut icon|index, follow)\b/i.test(
			text,
		)
	)
		return false;
	if (/(className|data-|aria-|xmlns|viewBox|strokeWidth)/.test(text))
		return false;
	if (/page (could |was )?not be found|return home|report an issue/i.test(text))
		return false;
	return true;
}

function utilityTokenCount(text: string) {
	return text
		.split(/\s+/)
		.filter((token) =>
			/^[a-z][a-z0-9:#[\]/.-]*-[a-z0-9:#[\]/.-]+$/i.test(token),
		).length;
}
