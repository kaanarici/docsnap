import { describe, expect, test } from "bun:test";
import {
	type DiscoverySource,
	type FetchedUrl,
	lowQualityConfidence,
} from "../src/core/types.ts";
import { extractPage } from "../src/extract/html.ts";
import { cleanMarkdown } from "../src/extract/markdown.ts";
import { scoreMarkdown } from "../src/extract/quality.ts";

type Extracted = Awaited<ReturnType<typeof extractPage>>;
type Success = Extract<Extracted, { ok: true }>;
type Failure = Extract<Extracted, { ok: false }>;

function extractFrom({
	body,
	contentType = "text/html",
	finalUrl,
	source = "seed",
	url,
}: {
	body: string;
	contentType?: string;
	finalUrl?: string;
	source?: DiscoverySource;
	url: string;
}): Promise<Extracted> {
	return extractPage({
		source,
		result: {
			ok: true,
			url,
			finalUrl: finalUrl ?? url,
			status: 200,
			contentType,
			body,
			fetchMs: 1,
		},
	} satisfies FetchedUrl);
}

function expectOk(record: Extracted): Success {
	expect(record.ok).toBe(true);
	if (!record.ok) throw new Error(record.error);
	return record;
}

function expectEmpty(record: Extracted): Failure {
	expect(record.ok).toBe(false);
	if (record.ok) throw new Error("expected empty failure");
	expect(record.failureKind).toBe("empty");
	return record;
}

describe("markdown quality scoring", () => {
	test.each([
		[
			`Enable JavaScript for an interactive summary table of WebKit's standards positions. Failing that, browse the [standards-positions GitHub repository](https://github.com/WebKit/standards-positions) directly.`,
			"Standards Positions",
		],
		[
			`A declarative, efficient and flexible JavaScript library for building user interfaces.\n\nSolid is a purely reactive library. It was designed from the ground up with a reactive core. It's influenced by reactive principles developed by previous libraries.`,
			"SolidJS",
		],
		[
			`Sinatra is a DSL for quickly creating web applications in Ruby with minimal effort:\n\n\`\`\`ruby\nrequire 'sinatra'\nget '/frank-says' do\n  'Put this in your pipe & smoke it!'\nend\n\`\`\``,
			"Sinatra",
		],
		[
			`Docs.rs no longer has its own badges. Consider using [shields.io](https://shields.io/) instead.`,
			"Badges",
		],
	])("accepts concise real docs: %s", (markdown, title) => {
		expect(scoreMarkdown(markdown, title).confidence).toBeGreaterThanOrEqual(
			lowQualityConfidence,
		);
	});
});

describe("app shells fail honestly", () => {
	test.each([
		[
			"docusaurus root",
			`<div id="__docusaurus"></div><script src="/assets/main.js"></script>`,
		],
		[
			"empty main with config",
			`<main></main><script>var zdWebClientConfig={"siteURL":"docs.example.com"}</script>`,
		],
		[
			"catalog app",
			`<title>Client Docs</title><body><catalog-app unresolved></catalog-app></body>`,
		],
		[
			"app root",
			`<title>Unreal Engine 5.7 Documentation</title><body><app-root class="app-root"></app-root><script src="main.js" type="module"></script></body>`,
		],
		[
			"empty app mount",
			`<title>Apply to Xavier</title><main><h1>Apply to Xavier</h1><nav>Xavier Home Apply to Xavier</nav><div id="app"></div></main>`,
		],
		[
			"script-loaded css data",
			`<title>CSS Status</title><main>properties</main><script>var loadCSSProperties = xhrPromise("https://raw.githubusercontent.com/example/project/main/data.json");</script>`,
		],
		[
			"search-only docusaurus",
			`<title>Plugins</title><div id="__docusaurus"><main><form><input type="search" placeholder="Search"><button>Search</button></form><h1></h1></main></div>`,
		],
	])("%s", async (_label, body) => {
		const appShell = expectEmpty(
			await extractFrom({
				url: "https://docs.example.com/docs/",
				body,
			}),
		);
		expect(appShell.error).toBe("app shell without static text");
	});

	test("keeps a short static page with script assets", async () => {
		const shortStaticPage = expectOk(
			await extractFrom({
				url: "https://docs.example.com/install",
				body: `<html><head><title>Install</title><link rel="stylesheet" href="/site.css"></head><body><main><h1>Install</h1><p>Install docsnap with Bun.</p></main><script src="/app.js"></script></body></html>`,
			}),
		);
		expect(shortStaticPage.markdown).toContain("Install docsnap with Bun.");
	});

	test("does not blank a short page whose title is a body substring", async () => {
		const shortPageWithAppMount = expectOk(
			await extractFrom({
				url: "https://docs.example.com/api",
				body: `<html><head><title>API</title></head><body><main><p>The API supports JSON and XML responses.</p></main><div id="app"></div></body></html>`,
			}),
		);
		expect(shortPageWithAppMount.markdown).toContain(
			"The API supports JSON and XML responses.",
		);
	});

	test("blanks a genuine title-only SPA shell", async () => {
		const titleOnlyShell = expectEmpty(
			await extractFrom({
				url: "https://app.example.com/",
				body: `<html><head><title>My App</title></head><body><h1>My App</h1><div id="app"></div></body></html>`,
			}),
		);
		expect(titleOnlyShell.failureKind).toBe("empty");
	});

	test("blanks a language selector without article content", async () => {
		const languageSelector = expectEmpty(
			await extractFrom({
				url: "https://ec.example.com/",
				finalUrl:
					"https://commission.example.com/select-language?destination=/node/1",
				body: `<html><head><title>Language selection</title></head><body class="path-select-language"><ul class="ecl-splash-page__language-list"><li><a href="/index_en"><span>en</span><span>English</span></a></li><li><a href="/index_fr"><span>fr</span><span>français</span></a></li></ul><script type="application/json">{"currentPath":"select-language"}</script></body></html>`,
			}),
		);
		expect(languageSelector.error).toBe(
			"language selector without article content",
		);
	});
});

describe("feeds and text-like assets", () => {
	test("excludes an atom feed reached as a crawl link", async () => {
		const atomFeed = expectEmpty(
			await extractFrom({
				source: "crawl",
				url: "https://example.com/atom/everything/",
				contentType: "application/atom+xml; charset=utf-8",
				body: `<?xml version="1.0" encoding="utf-8"?><feed xmlns="http://www.w3.org/2005/Atom"><title>Example Weblog</title><entry><title>Post one</title><link href="https://example.com/2026/post-one/"/><summary>First post summary.</summary></entry></feed>`,
			}),
		);
		expect(atomFeed.error).toBe(
			"feed resource used for discovery, not a content page",
		);
	});

	test("excludes a text/plain rss feed", async () => {
		const textPlainRssFeed = expectEmpty(
			await extractFrom({
				source: "crawl",
				url: "https://example.com/feed.txt",
				contentType: "text/plain",
				body: `<?xml version="1.0"?><rss version="2.0"><channel><title>Example</title><item><title>One</title><link>https://example.com/one</link></item></channel></rss>`,
			}),
		);
		expect(textPlainRssFeed.failureKind).toBe("empty");
	});

	test("captures plain markdown text", async () => {
		const plainMarkdown = expectOk(
			await extractFrom({
				url: "https://example.com/readme.txt",
				contentType: "text/plain",
				body: "# Plain docs\n\nInstall the command line tool, configure the output directory, and inspect the generated Markdown corpus.",
			}),
		);
		expect(plainMarkdown.extractor).toBe("markdown");
	});

	test("excludes an application/xml rss feed", async () => {
		const rssFeed = expectEmpty(
			await extractFrom({
				source: "crawl",
				url: "https://example.com/feed.xml",
				contentType: "application/xml",
				body: `<?xml version="1.0"?><rss version="2.0"><channel><title>Example</title><item><title>One</title><link>https://example.com/one</link></item></channel></rss>`,
			}),
		);
		expect(rssFeed.failureKind).toBe("empty");
	});

	test("captures a non-feed xml asset as text", async () => {
		const xmlConfig = expectOk(
			await extractFrom({
				url: "https://example.com/config.xml",
				contentType: "application/xml",
				body: `<?xml version="1.0"?><configuration><setting name="theme">dark mode preference for the public documentation viewer surface</setting></configuration>`,
			}),
		);
		expect(xmlConfig.extractor).toBe("text");
	});

	test("excludes an rss 1.0 rdf feed", async () => {
		const rdfFeed = expectEmpty(
			await extractFrom({
				source: "crawl",
				url: "https://example.com/rdf",
				contentType: "application/xml",
				body: `<?xml version="1.0"?><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns="http://purl.org/rss/1.0/"><channel><title>Example</title></channel><item><title>One</title><link>https://example.com/one</link></item></rdf:RDF>`,
			}),
		);
		expect(rdfFeed.failureKind).toBe("empty");
	});

	test("captures xhtml content without raw text fencing", async () => {
		const xhtml = expectOk(
			await extractFrom({
				url: "https://example.com/page",
				contentType: "application/xhtml+xml",
				body: `<html xmlns="http://www.w3.org/1999/xhtml"><head><title>XHTML Page</title></head><body><main><h1>XHTML Page</h1><p>This is a real public documentation content page served as xhtml, not a feed, so it must be captured.</p></main></body></html>`,
			}),
		);
		expect(xhtml.extractor).toBe("html");
		expect(xhtml.markdown).toContain("real public documentation content page");
		expect(xhtml.markdown).not.toContain("```");
	});

	test("fences a structured text asset with more backticks than its body run", async () => {
		const backtickAsset = expectOk(
			await extractFrom({
				url: "https://example.com/snippet.json",
				contentType: "application/json",
				body: '{"snippet": "use ````` to fence a block"}',
			}),
		);
		expect(backtickAsset.extractor).toBe("text");
		const assetFences = backtickAsset.markdown.match(/^`{3,}/gm) ?? [];
		expect(assetFences).toHaveLength(2);
		expect(assetFences[0]!.length).toBeGreaterThanOrEqual(6);
		expect(backtickAsset.markdown).toContain("use ````` to fence");
	});
});

describe("html extraction recovery", () => {
	test("uses meta og title for confidence scoring", async () => {
		const metaTitlePage = expectOk(
			await extractFrom({
				url: "https://solid.example.com/",
				body: `<html><head><meta name="og:title" content="SolidJS"></head><body><main><p>A declarative, efficient and flexible JavaScript library for building user interfaces.</p><p>Solid is a purely reactive library. It was designed from the ground up with a reactive core. It's influenced by reactive principles developed by previous libraries.</p></main></body></html>`,
			}),
		);
		expect(metaTitlePage.title).toBe("SolidJS");
		expect(metaTitlePage.confidence).toBeGreaterThanOrEqual(
			lowQualityConfidence,
		);
	});

	test("recovers link-heavy structured content without nav chrome", async () => {
		const linkOnlyRecovery = expectOk(
			await extractFrom({
				url: "https://docs.example.com/docs/",
				body: `<html><head><title>Grommet</title></head><body><div><a href="/">grommet</a><a href="/docs">docs</a><a href="/components">components</a></div><div><h1>Docs</h1><h2>you got questions, we got some answers. something missing? hit us up on <a href="https://slack.example.com">slack</a>, or open an <a href="https://github.com/example/issues">issue</a>.</h2><h3><a href="/starter">getting started with grommet</a></h3><h3><a href="/functions">functions</a></h3><h3><a href="/resources">resources</a></h3><h3><a href="/browsers">browser support</a></h3></div></body></html>`,
			}),
		);
		expect(linkOnlyRecovery.extractor).toBe("structured");
		expect(linkOnlyRecovery.markdown).toContain("# Docs");
		expect(linkOnlyRecovery.markdown).toContain("## you got questions");
		expect(linkOnlyRecovery.markdown).not.toContain("grommet docs components");
	});

	test("recovers media-heavy structured content", async () => {
		const mediaOnlyRecovery = expectOk(
			await extractFrom({
				url: "https://developer.example.com/",
				body: `<html><head><title>Apple Developer</title></head><body><main><article><img src="hero.png"><img src="icon.png"></article><div><h1>Develop for Apple platforms</h1><p>There has never been a better time to develop for Apple platforms.</p><p>Explore tools, documentation, sessions, and pathways for building apps.</p></div></main></body></html>`,
			}),
		);
		expect(mediaOnlyRecovery.extractor).toBe("structured");
		expect(mediaOnlyRecovery.markdown).toContain("Develop for Apple platforms");
	});

	test("recovers content from chrome-heavy structured pages", async () => {
		const chromeOnlyRecovery = expectOk(
			await extractFrom({
				url: "https://example.edu/academics/programs/",
				body: `<html><head><title>Degree Programs</title></head><body><main><article><img src="hero.jpg"><a href="/">Home</a> &gt; <a href="/academics/">Academics</a> &gt; Programs</article><section><h1>Degree Programs</h1><p>Choose from undergraduate, graduate, online, and international programs across many areas of study.</p><p>Explore academic paths, admissions options, financial aid, and campus resources.</p></section></main></body></html>`,
			}),
		);
		expect(chromeOnlyRecovery.extractor).toBe("structured");
		expect(chromeOnlyRecovery.markdown).toContain("Choose from undergraduate");
		expect(chromeOnlyRecovery.markdown).not.toContain("Home");
	});

	test("falls back to a page outline for a very large reference page", async () => {
		const largeOutline = expectOk(
			await extractFrom({
				url: "https://developer.example.com/api/reference/",
				body: `<html><head><title>API Reference</title><meta name="description" content="Complete API endpoint reference."></head><body>${Array.from(
					{ length: 520 },
					(_, index) => `<a href="#endpoint-${index}">Endpoint ${index}</a>`,
				).join(
					"",
				)}<h1>API Reference</h1><h2>Payment Transactions</h2><h3>Charge a Credit Card</h3><h3>Refund a Transaction</h3><h3>Void a Transaction</h3>${"x".repeat(2_000_000)}</body></html>`,
			}),
		);
		expect(largeOutline.extractor).toBe("fallback");
		expect(largeOutline.markdown).toContain("## Page Outline");
		expect(largeOutline.markdown).toContain("Payment Transactions");
		expect(largeOutline.markdown).not.toContain("Endpoint 519");
	});
});

describe("markdown cleanup", () => {
	test("collapses and caps multi-line stock-photo caption alt text", () => {
		const captionAlt = `${"Mandatory Credit Photo by agency. A view of a building that serves a purpose. ".repeat(8)}`;
		const cappedImage = cleanMarkdown(
			`![${captionAlt.replace(/\. /g, ".\n\t")}](https://cdn.example/img.jpg)`,
		);
		const cappedAltText = cappedImage.match(/!\[([^\]]*)\]/)?.[1] ?? "";
		expect(cappedAltText.length).toBeLessThanOrEqual(250);
		expect(cappedAltText).not.toContain("\n");
		expect(cappedAltText.endsWith("…")).toBe(true);
		expect(cappedImage).toContain("](https://cdn.example/img.jpg)");
		const shortImage = cleanMarkdown("![fetch then extract diagram](/x.png)");
		expect(shortImage).toContain("![fetch then extract diagram](/x.png)");
	});

	test("drops standalone ad-slot labels but keeps headings and in-sentence use", () => {
		const adStripped = cleanMarkdown(
			"## How to tie a tie\n\nFirst step.\n\nAdvertisement\n\nSecond step.\n\nSPONSORED\n\nDone.",
		);
		expect(adStripped).not.toMatch(/^advertisement$/im);
		expect(adStripped).not.toMatch(/^sponsored$/im);
		expect(adStripped).toContain("First step.");
		expect(adStripped).toContain("Second step.");
		const adKept = cleanMarkdown(
			"## Advertisement\n\nThe advertisement industry is large.",
		);
		expect(adKept).toContain("## Advertisement");
		expect(adKept).toContain("The advertisement industry is large.");
	});

	test("drops standalone chrome labels but keeps semantic uses", () => {
		const chromeLabels = [
			"Accept all cookies",
			"Accept cookies",
			"We use cookies",
			"Cookie Policy",
			"Manage cookies",
			"Got it",
			"Share this",
			"Share",
			"Tweet",
			"Follow us",
			"Back to top",
			"Skip to content",
			"Skip to main content",
			"Print this page",
			"Most read",
			"Most popular",
			"Related articles",
			"Related stories",
			"Read more",
			"Sign up",
			"Subscribe",
			"Newsletter",
		];
		const chromeStripped = cleanMarkdown(
			["First paragraph.", ...chromeLabels, "Last paragraph."].join("\n\n"),
		);
		expect(chromeStripped).toContain("First paragraph.");
		expect(chromeStripped).toContain("Last paragraph.");
		const chromeLines = chromeStripped
			.split("\n")
			.map((line) => line.trim().toLowerCase());
		for (const label of chromeLabels) {
			expect(chromeLines).not.toContain(label.toLowerCase());
		}
		expect(
			cleanMarkdown("Intro.\n\nAccept   all cookies\n\nDone."),
		).not.toContain("Accept");

		const chromeKept = cleanMarkdown(
			"## Cookie Policy\n\nThe guide explains how you can subscribe to release updates.\n\n- Subscribe\n\n> Share",
		);
		expect(chromeKept).toContain("## Cookie Policy");
		expect(chromeKept).toContain(
			"The guide explains how you can subscribe to release updates.",
		);
		expect(chromeKept).toContain("- Subscribe");
		expect(chromeKept).toContain("> Share");
	});
});
