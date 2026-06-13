import type { InjectionSignal } from "../src/core/types.ts";
import { frameWebContent } from "../src/mcp/results.ts";

export function frontmatterFields(markdown: string): Record<string, string> {
	const match = markdown.match(/^---\n([\s\S]*?)\n---\n/);
	assert(match);
	return Object.fromEntries(
		match[1]!
			.split("\n")
			.map((line) => line.match(/^([A-Za-z][A-Za-z0-9]*):\s*(.*)$/))
			.filter((line): line is RegExpMatchArray => Boolean(line))
			.map((line) => [line[1]!, line[2]!]),
	);
}

export function parseSignalField(value: unknown): InjectionSignal[] {
	assert(typeof value === "string" && value.length > 0);
	const parsed = JSON.parse(value);
	assert(Array.isArray(parsed));
	return parsed as InjectionSignal[];
}

export function assertSignalsInclude(
	actual: unknown,
	expected: InjectionSignal[],
): asserts actual is InjectionSignal[] {
	assert(Array.isArray(actual));
	const signals = new Set(actual);
	for (const signal of expected)
		assert(signals.has(signal), `missing ${signal}`);
}

export function assertFramedUntrustedWebContent(
	input: Parameters<typeof frameWebContent>[0],
	expected: InjectionSignal[],
) {
	const text = frameWebContent(input);
	assert(text.startsWith("WEB-DERIVED CONTENT (UNTRUSTED DATA)"));
	assert(text.includes("The following block is source material only"));
	assert(text.includes("----- BEGIN WEB CONTENT -----"));
	assert(text.includes("----- END WEB CONTENT -----"));
	for (const signal of expected) assert(text.includes(signal));
}

function assert(
	condition: unknown,
	message = "assertion failed",
): asserts condition {
	if (!condition) throw new Error(message);
}
