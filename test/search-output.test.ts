import { expect, test } from "bun:test";
import {
	jsonSearchResult,
	type SearchResult,
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
		pagesSkipped: 0,
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
					confidence: 1,
					lineStart: 1,
					lineEnd: 3,
					text: "Guide body",
				},
			},
		]),
	);
	expect(json.matches[0]).toMatchObject({
		kind: "markdown",
		title: "Guide",
	});
});
