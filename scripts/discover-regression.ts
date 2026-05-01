import { parseArgs } from "../src/cli/args.ts";
import { discoverLlms } from "../src/discover/llms.ts";
import { discoverNav } from "../src/discover/nav.ts";
import { setFetchTransportForTest } from "../src/fetch/fetcher.ts";

const links = discoverNav(
	`<nav>
		<a class="nav-link" href="/general/downloads">Releases</a>
		<a class="nav-link dropdown-toggle" href="/Document" role="button" data-bs-toggle="dropdown" aria-expanded="false">Documentation</a>
		<ul><li><a class="dropdown-item" href="/docs/latest/">Latest</a></li></ul>
	</nav>`,
	"https://hive.apache.org/",
);

assert(links.includes("https://hive.apache.org/general/downloads"));
assert(links.includes("https://hive.apache.org/docs/latest/"));
assert(!links.includes("https://hive.apache.org/Document"));

const parsed = parseArgs(["https://docs.example.com/", "-m", "4"]);
assert(!("help" in parsed) && !("version" in parsed));

setFetchTransportForTest(async (input) => {
	return {
		url: String(input),
		status: 200,
		headers: {
			get: (name) => (name === "content-type" ? "text/markdown" : null),
			getSetCookie: () => [],
		},
		body: new TextEncoder().encode(`# Docs

- [Release notes](releases/index.html.md): * [Upgrading](upgrading.md)
- [Usage guide](topics/index.html.md): * [Pages](pages.md)
- German (Deutsch) - 133 pages - /docs/de - Visit website for content
- [API](api/index.md): API reference`),
	};
});
try {
	const urls = await discoverLlms("https://docs.example.com/", parsed);
	assert(urls.includes("https://docs.example.com/llms.txt"));
	assert(!urls.includes("https://docs.example.com/upgrading.md"));
	assert(!urls.includes("https://docs.example.com/pages.md"));
	assert(!urls.includes("https://docs.example.com/docs/de"));
} finally {
	setFetchTransportForTest(undefined);
}

function assert(condition: unknown): asserts condition {
	if (!condition) throw new Error("assertion failed");
}
