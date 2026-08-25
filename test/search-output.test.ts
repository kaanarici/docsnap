import { expect, test } from "bun:test";
import {
	jsonSearchResult,
	type SearchResult,
	textSearchResult,
} from "../src/cli/search-output.ts";

function emptySearch(matches: SearchResult["matches"]): SearchResult {
	return {
		matches,
		corporaScanned: 1,
		corporaSearched: 1,
		corporaSkipped: 0,
		corporaTruncated: false,
		truncated: false,
		limited: false,
		injectionFiltered: 0,
	};
}

test("includes page kind on citations when present", () => {
	const json = jsonSearchResult(
		{
			outputDir: "/tmp/corpus",
			query: "guide",
			limit: 8,
			json: true,
			all: false,
			includeInjection: false,
		},
		emptySearch([
			{
				corpusDir: "/tmp/corpus",
				match: {
					record: {
						ok: true,
						url: "https://docs.example.com/guide",
						finalUrl: "https://docs.example.com/guide",
						outputPath: "guide.md",
						injectionSignals: [],
						title: "Guide",
						kind: "markdown",
					},
					contentHash: "a".repeat(64),
					extractor: "markdown",
					score: 1,
					lineStart: 1,
					lineEnd: 3,
					text: "Guide body",
				},
			},
		]),
	);
	const serialized = JSON.parse(JSON.stringify(json));
	expect(serialized).not.toHaveProperty("corporaScanned");
	expect(serialized.matches[0]).toEqual({
		citationId: `guide.md#L1-L3@${"a".repeat(12)}`,
		path: "guide.md",
		url: "https://docs.example.com/guide",
		finalUrl: "https://docs.example.com/guide",
		lineStart: 1,
		lineEnd: 3,
		snippet: "Guide body",
		kind: "markdown",
		title: "Guide",
	});
});

test("keeps text citations useful without internal ranking diagnostics", () => {
	const input = {
		outputDir: "/tmp/corpus",
		query: "guide",
		limit: 8,
		json: false,
		all: false,
		includeInjection: false,
	};
	const result = emptySearch([
		{
			corpusDir: "/tmp/corpus",
			match: {
				record: {
					ok: true,
					url: "https://docs.example.com/guide",
					finalUrl: "https://docs.example.com/guide",
					outputPath: "guide.md",
					injectionSignals: [],
					qualityReasons: ["inline state may omit content"],
					title: "Guide",
					kind: "markdown",
				},
				contentHash: "a".repeat(64),
				extractor: "markdown",
				score: 1,
				lineStart: 4,
				lineEnd: 6,
				text: "Guide body",
			},
		},
	]);
	const text = textSearchResult(input, result);
	expect(text).toContain("guide.md#L4-L6");
	expect(text).toContain("Guide body");
	expect(text).toContain("warning: inline state may omit content");
	expect(text).not.toContain("score:");
	expect(text).not.toContain("confidence:");
	expect(text).not.toContain("extractor:");
});
