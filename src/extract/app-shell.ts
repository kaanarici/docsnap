import { parseHTML } from "linkedom";
import { whitespaceKey, wordCount } from "../core/text.ts";

const shellFrameworkMarkers = [
	"catalog-app",
	"react-target",
	"app-root",
	"ohcglobal",
	"__meteor_runtime_config__",
];
const rawGithubMarker = String.raw`raw\.githubusercontent\.com`;
const emptyAppIdMarker = `id=["']app["']`;
const shellPlaceholderMarkers = markerPattern([
	...shellFrameworkMarkers,
	rawGithubMarker,
]);
const emptyShellMarkers = markerPattern([
	"__docusaurus",
	"v-app-loading",
	"enable javascript in your browser",
	"zdWebClientConfig",
	...shellFrameworkMarkers,
	emptyAppIdMarker,
	rawGithubMarker,
]);
const discoveryShellMarkers = markerPattern([
	"zdWebClientConfig",
	...shellFrameworkMarkers,
]);

export function isShellPlaceholder(
	markdown: string,
	title: string | undefined,
	html: string,
) {
	return (
		(((Boolean(title) &&
			markdown.replace(/^#+\s*/, "").trim() === title?.trim()) ||
			(wordCount(markdown) <= 2 && rawGithubOrXhr(html))) &&
			shellPlaceholderMarkers.test(html)) ||
		(/^\s*search\s*$/i.test(markdown) &&
			/<input[^>]+type=["']search["']|placeholder=["']search["']|class=["'][^"']*search/i.test(
				html,
			) &&
			/__docusaurus/i.test(html)) ||
		(title !== undefined &&
			wordCount(markdown) <= 8 &&
			markdown.includes(title) &&
			/<div[^>]+id=["']app["'][^>]*>\s*<\/div>/i.test(html))
	);
}

export function emptyContentError(html: string) {
	return emptyShellMarkers.test(html)
		? "app shell without static text"
		: "empty content";
}

export function looksLikeAppShell(html: string): boolean {
	if (discoveryShellMarkers.test(html)) return true;
	const { document } = parseHTML(html);
	const scriptCount = document.querySelectorAll(
		"script[src],link[href]",
	).length;
	if (scriptCount === 0) return false;
	document.querySelectorAll("script,style,noscript").forEach((node) => {
		node.remove();
	});
	const bodyText = whitespaceKey(document.body?.textContent ?? "");
	const anchorCount = document.querySelectorAll("a[href]").length;
	return bodyText.length < 500 && anchorCount < 5;
}

export function chromeHeading(text: string) {
	return /^(our api|hello world|support|sign in|search(?: developer site)?)$/i.test(
		text,
	);
}

export function isBlockedChallenge(
	markdown: string,
	title: string | undefined,
) {
	return (
		/client challenge/i.test(title ?? "") ||
		/required part of this site couldn.t load/i.test(markdown)
	);
}

export function isLanguageSelector(finalUrl: string, html: string) {
	return (
		/\/select-language(?:[/?#]|$)/i.test(finalUrl) &&
		/path-select-language|ecl-splash-page__language|currentPath":"select-language/i.test(
			html,
		)
	);
}

function rawGithubOrXhr(html: string) {
	return /raw\.githubusercontent\.com|xhrPromise/i.test(html);
}

function markerPattern(sources: string[]) {
	return new RegExp(sources.join("|"), "i");
}
