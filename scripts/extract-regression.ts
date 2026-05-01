import type { FetchedUrl } from "../src/core/types.ts";
import { extractPage } from "../src/extract/html.ts";

for (const body of [
	`<div id="__docusaurus"></div><script src="/assets/main.js"></script>`,
	`<main></main><script>var zdWebClientConfig={"siteURL":"docs.example.com"}</script>`,
	`<title>Client Docs</title><body><catalog-app unresolved></catalog-app></body>`,
	`<title>CSS Status</title><main>properties</main><script>var loadCSSProperties = xhrPromise("https://raw.githubusercontent.com/example/project/main/data.json");</script>`,
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

function assert(condition: unknown): asserts condition {
	if (!condition) throw new Error("assertion failed");
}
