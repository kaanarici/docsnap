import { type FetchedUrl, lowQualityConfidence } from "../src/core/types.ts";
import { extractPage } from "../src/extract/html.ts";
import { scoreMarkdown } from "../src/extract/quality.ts";

assert(
	scoreMarkdown(
		`Enable JavaScript for an interactive summary table of WebKit's standards positions. Failing that, browse the [standards-positions GitHub repository](https://github.com/WebKit/standards-positions) directly.`,
		"Standards Positions",
	).confidence >= lowQualityConfidence,
);
assert(
	scoreMarkdown(
		`A declarative, efficient and flexible JavaScript library for building user interfaces.\n\nSolid is a purely reactive library. It was designed from the ground up with a reactive core. It's influenced by reactive principles developed by previous libraries.`,
		"SolidJS",
	).confidence >= lowQualityConfidence,
);
assert(
	scoreMarkdown(
		`Sinatra is a DSL for quickly creating web applications in Ruby with minimal effort:\n\n\`\`\`ruby\nrequire 'sinatra'\nget '/frank-says' do\n  'Put this in your pipe & smoke it!'\nend\n\`\`\``,
		"Sinatra",
	).confidence >= lowQualityConfidence,
);

for (const body of [
	`<div id="__docusaurus"></div><script src="/assets/main.js"></script>`,
	`<main></main><script>var zdWebClientConfig={"siteURL":"docs.example.com"}</script>`,
	`<title>Client Docs</title><body><catalog-app unresolved></catalog-app></body>`,
	`<title>Unreal Engine 5.7 Documentation</title><body><app-root class="app-root"></app-root><script src="main.js" type="module"></script></body>`,
	`<title>Apply to Xavier</title><main><h1>Apply to Xavier</h1><nav>Xavier Home Apply to Xavier</nav><div id="app"></div></main>`,
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

const metaTitlePage = await extractPage({
	source: "seed",
	result: {
		ok: true,
		url: "https://solid.example.com/",
		finalUrl: "https://solid.example.com/",
		status: 200,
		contentType: "text/html",
		body: `<html><head><meta name="og:title" content="SolidJS"></head><body><main><p>A declarative, efficient and flexible JavaScript library for building user interfaces.</p><p>Solid is a purely reactive library. It was designed from the ground up with a reactive core. It's influenced by reactive principles developed by previous libraries.</p></main></body></html>`,
		fetchMs: 1,
	},
} satisfies FetchedUrl);
assert(metaTitlePage.ok);
assert(metaTitlePage.title === "SolidJS");
assert(metaTitlePage.confidence >= lowQualityConfidence);

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

const mediaOnlyRecovery = await extractPage({
	source: "seed",
	result: {
		ok: true,
		url: "https://developer.example.com/",
		finalUrl: "https://developer.example.com/",
		status: 200,
		contentType: "text/html",
		body: `<html><head><title>Apple Developer</title></head><body><main><article><img src="hero.png"><img src="icon.png"></article><div><h1>Develop for Apple platforms</h1><p>There has never been a better time to develop for Apple platforms.</p><p>Explore tools, documentation, sessions, and pathways for building apps.</p></div></main></body></html>`,
		fetchMs: 1,
	},
} satisfies FetchedUrl);
assert(mediaOnlyRecovery.ok);
assert(mediaOnlyRecovery.extractor === "fallback");
assert(mediaOnlyRecovery.markdown.includes("Develop for Apple platforms"));

const chromeOnlyRecovery = await extractPage({
	source: "seed",
	result: {
		ok: true,
		url: "https://example.edu/academics/programs/",
		finalUrl: "https://example.edu/academics/programs/",
		status: 200,
		contentType: "text/html",
		body: `<html><head><title>Degree Programs</title></head><body><main><article><img src="hero.jpg"><a href="/">Home</a> &gt; <a href="/academics/">Academics</a> &gt; Programs</article><section><h1>Degree Programs</h1><p>Choose from undergraduate, graduate, online, and international programs across many areas of study.</p><p>Explore academic paths, admissions options, financial aid, and campus resources.</p></section></main></body></html>`,
		fetchMs: 1,
	},
} satisfies FetchedUrl);
assert(chromeOnlyRecovery.ok);
assert(chromeOnlyRecovery.extractor === "fallback");
assert(chromeOnlyRecovery.markdown.includes("Choose from undergraduate"));

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
