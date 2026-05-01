import type { FetchedUrl } from "../src/core/types.ts";
import { extractPage } from "../src/extract/html.ts";

for (const body of [
	`<div id="__docusaurus"></div><script src="/assets/main.js"></script>`,
	`<main></main><script>var zdWebClientConfig={"siteURL":"docs.example.com"}</script>`,
	`<title>Client Docs</title><body><catalog-app unresolved></catalog-app></body>`,
	`<title>Unreal Engine 5.7 Documentation</title><body><app-root class="app-root"></app-root><script src="main.js" type="module"></script></body>`,
	`<title>CSS Status</title><main>properties</main><script>var loadCSSProperties = xhrPromise("https://raw.githubusercontent.com/example/project/main/data.json");</script>`,
	`<title>Plugins</title><div id="__docusaurus"><main><form><input type="search" placeholder="Search"><button>Search</button></form><h1></h1></main></div>`,
]) {
	const appShell = await extractPage({
		source: "seed",
		result: {
			ok: true,
			url: "https://docs.example.com/docs/",
			finalUrl: "https://docs.example.com/docs/",
			status: 200,
			contentType: "text/html",
			body,
			fetchMs: 1,
		},
	} satisfies FetchedUrl);
	assert(!appShell.ok);
	assert(appShell.failureKind === "empty");
	assert(appShell.error === "app shell without static text");
}

const linkOnlyRecovery = await extractPage({
	source: "seed",
	result: {
		ok: true,
		url: "https://docs.example.com/docs/",
		finalUrl: "https://docs.example.com/docs/",
		status: 200,
		contentType: "text/html",
		body: `<html><head><title>Grommet</title></head><body><div><a href="/">grommet</a><a href="/docs">docs</a><a href="/components">components</a></div><div><h1>Docs</h1><h2>you got questions, we got some answers. something missing? hit us up on <a href="https://slack.example.com">slack</a>, or open an <a href="https://github.com/example/issues">issue</a>.</h2><h3><a href="/starter">getting started with grommet</a></h3><h3><a href="/functions">functions</a></h3><h3><a href="/resources">resources</a></h3><h3><a href="/browsers">browser support</a></h3></div></body></html>`,
		fetchMs: 1,
	},
} satisfies FetchedUrl);
assert(linkOnlyRecovery.ok);
assert(linkOnlyRecovery.extractor === "fallback");
assert(linkOnlyRecovery.markdown.includes("Docs you got questions"));
assert(linkOnlyRecovery.markdown.includes("grommet docs components"));

const languageSelector = await extractPage({
	source: "seed",
	result: {
		ok: true,
		url: "https://ec.example.com/",
		finalUrl:
			"https://commission.example.com/select-language?destination=/node/1",
		status: 200,
		contentType: "text/html",
		body: `<html><head><title>Language selection</title></head><body class="path-select-language"><ul class="ecl-splash-page__language-list"><li><a href="/index_en"><span>en</span><span>English</span></a></li><li><a href="/index_fr"><span>fr</span><span>français</span></a></li></ul><script type="application/json">{"currentPath":"select-language"}</script></body></html>`,
		fetchMs: 1,
	},
} satisfies FetchedUrl);
assert(!languageSelector.ok);
assert(languageSelector.failureKind === "empty");
assert(languageSelector.error === "language selector without article content");

function assert(condition: unknown): asserts condition {
	if (!condition) throw new Error("assertion failed");
}
