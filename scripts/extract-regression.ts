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
assert(
	scoreMarkdown(
		`Docs.rs no longer has its own badges. Consider using [shields.io](https://shields.io/) instead.`,
		"Badges",
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

const loadingShell = await extractPage({
	source: "seed",
	result: {
		ok: true,
		url: "https://docs.example.com/loading",
		finalUrl: "https://docs.example.com/loading",
		status: 200,
		contentType: "text/html",
		body: `<html><head><title>Docs</title><link rel="stylesheet" href="/app.css"></head><body><main>Loading documentation, please wait...</main><script src="/app.js"></script></body></html>`,
		fetchMs: 1,
	},
} satisfies FetchedUrl);
assert(!loadingShell.ok);
assert(loadingShell.failureKind === "empty");
assert(loadingShell.error === "app shell without static text");

const shortStaticPage = await extractPage({
	source: "seed",
	result: {
		ok: true,
		url: "https://docs.example.com/install",
		finalUrl: "https://docs.example.com/install",
		status: 200,
		contentType: "text/html",
		body: `<html><head><title>Install</title><link rel="stylesheet" href="/site.css"></head><body><main><h1>Install</h1><p>Install docsnap with Bun.</p></main><script src="/app.js"></script></body></html>`,
		fetchMs: 1,
	},
} satisfies FetchedUrl);
assert(shortStaticPage.ok);
assert(shortStaticPage.markdown.includes("Install docsnap with Bun."));

// rss/atom feeds are discovery sources, not content pages: a feed reached as a
// crawl link must be excluded, not captured as raw fenced XML
const atomFeed = await extractPage({
	source: "crawl",
	result: {
		ok: true,
		url: "https://example.com/atom/everything/",
		finalUrl: "https://example.com/atom/everything/",
		status: 200,
		contentType: "application/atom+xml; charset=utf-8",
		body: `<?xml version="1.0" encoding="utf-8"?><feed xmlns="http://www.w3.org/2005/Atom"><title>Example Weblog</title><entry><title>Post one</title><link href="https://example.com/2026/post-one/"/><summary>First post summary.</summary></entry></feed>`,
		fetchMs: 1,
	},
} satisfies FetchedUrl);
assert(!atomFeed.ok);
assert(atomFeed.failureKind === "empty");
assert(
	atomFeed.error === "feed resource used for discovery, not a content page",
);

const textPlainRssFeed = await extractPage({
	source: "crawl",
	result: {
		ok: true,
		url: "https://example.com/feed.txt",
		finalUrl: "https://example.com/feed.txt",
		status: 200,
		contentType: "text/plain",
		body: `<?xml version="1.0"?><rss version="2.0"><channel><title>Example</title><item><title>One</title><link>https://example.com/one</link></item></channel></rss>`,
		fetchMs: 1,
	},
} satisfies FetchedUrl);
assert(!textPlainRssFeed.ok);
assert(textPlainRssFeed.failureKind === "empty");

const plainMarkdown = await extractPage({
	source: "seed",
	result: {
		ok: true,
		url: "https://example.com/readme.txt",
		finalUrl: "https://example.com/readme.txt",
		status: 200,
		contentType: "text/plain",
		body: "# Plain docs\n\nInstall the command line tool, configure the output directory, and inspect the generated Markdown corpus.",
		fetchMs: 1,
	},
} satisfies FetchedUrl);
assert(plainMarkdown.ok);
assert(plainMarkdown.extractor === "markdown");

// an rss feed served as application/xml (caught via the feed-root parse)
const rssFeed = await extractPage({
	source: "crawl",
	result: {
		ok: true,
		url: "https://example.com/feed.xml",
		finalUrl: "https://example.com/feed.xml",
		status: 200,
		contentType: "application/xml",
		body: `<?xml version="1.0"?><rss version="2.0"><channel><title>Example</title><item><title>One</title><link>https://example.com/one</link></item></channel></rss>`,
		fetchMs: 1,
	},
} satisfies FetchedUrl);
assert(!rssFeed.ok);
assert(rssFeed.failureKind === "empty");

// a non-feed xml asset is still captured as a text asset (not excluded)
const xmlConfig = await extractPage({
	source: "seed",
	result: {
		ok: true,
		url: "https://example.com/config.xml",
		finalUrl: "https://example.com/config.xml",
		status: 200,
		contentType: "application/xml",
		body: `<?xml version="1.0"?><configuration><setting name="theme">dark mode preference for the public documentation viewer surface</setting></configuration>`,
		fetchMs: 1,
	},
} satisfies FetchedUrl);
assert(xmlConfig.ok);
assert(xmlConfig.extractor === "text");

// an rss 1.0 / rdf feed (namespaced <rdf:RDF> root) is also excluded
const rdfFeed = await extractPage({
	source: "crawl",
	result: {
		ok: true,
		url: "https://example.com/rdf",
		finalUrl: "https://example.com/rdf",
		status: 200,
		contentType: "application/xml",
		body: `<?xml version="1.0"?><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns="http://purl.org/rss/1.0/"><channel><title>Example</title></channel><item><title>One</title><link>https://example.com/one</link></item></rdf:RDF>`,
		fetchMs: 1,
	},
} satisfies FetchedUrl);
assert(!rdfFeed.ok);
assert(rdfFeed.failureKind === "empty");

// xhtml is a real content page (matches the xml content-type guard but is not a
// feed) and must NOT be excluded
const xhtml = await extractPage({
	source: "seed",
	result: {
		ok: true,
		url: "https://example.com/page",
		finalUrl: "https://example.com/page",
		status: 200,
		contentType: "application/xhtml+xml",
		body: `<html xmlns="http://www.w3.org/1999/xhtml"><head><title>XHTML Page</title></head><body><main><h1>XHTML Page</h1><p>This is a real public documentation content page served as xhtml, not a feed, so it must be captured.</p></main></body></html>`,
		fetchMs: 1,
	},
} satisfies FetchedUrl);
assert(xhtml.ok);
assert(xhtml.extractor === "html");
assert(xhtml.markdown.includes("real public documentation content page"));
assert(!xhtml.markdown.includes("```"));

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
assert(linkOnlyRecovery.extractor === "structured");
assert(linkOnlyRecovery.markdown.includes("# Docs"));
assert(linkOnlyRecovery.markdown.includes("## you got questions"));
assert(!linkOnlyRecovery.markdown.includes("grommet docs components"));

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
assert(mediaOnlyRecovery.extractor === "structured");
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
assert(chromeOnlyRecovery.extractor === "structured");
assert(chromeOnlyRecovery.markdown.includes("Choose from undergraduate"));
assert(!chromeOnlyRecovery.markdown.includes("Home"));

const largeOutline = await extractPage({
	source: "seed",
	result: {
		ok: true,
		url: "https://developer.example.com/api/reference/",
		finalUrl: "https://developer.example.com/api/reference/",
		status: 200,
		contentType: "text/html",
		body: `<html><head><title>API Reference</title><meta name="description" content="Complete API endpoint reference."></head><body>${Array.from(
			{ length: 520 },
			(_, index) => `<a href="#endpoint-${index}">Endpoint ${index}</a>`,
		).join(
			"",
		)}<h1>API Reference</h1><h2>Payment Transactions</h2><h3>Charge a Credit Card</h3><h3>Refund a Transaction</h3><h3>Void a Transaction</h3>${"x".repeat(2_000_000)}</body></html>`,
		fetchMs: 1,
	},
} satisfies FetchedUrl);
assert(largeOutline.ok);
assert(largeOutline.extractor === "fallback");
assert(largeOutline.markdown.includes("## Page Outline"));
assert(largeOutline.markdown.includes("Payment Transactions"));
assert(!largeOutline.markdown.includes("Endpoint 519"));

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
