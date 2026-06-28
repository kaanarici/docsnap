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
			markdown.replace(/^#+\s*/, "").trim() === title.trim() &&
			/<div[^>]+id=["']app["'][^>]*>\s*<\/div>/i.test(html))
	);
}

export function isLoadingShellPlaceholder(markdown: string, html: string) {
	if (!looksLikeAppShell(html)) return false;
	const compact = placeholderText(markdown);
	if (!compact || wordCount(compact) > 16 || compact.length > 180) {
		return false;
	}
	if (/\byou need to enable javascript to run this app\b/i.test(compact)) {
		return true;
	}
	const tokens = compact
		.split(/\s+/)
		.filter((token) => !loadingStopWords.has(token));
	if (tokens.length === 0) return false;
	const placeholder = tokens.filter((token) =>
		loadingPlaceholderWords.has(token),
	).length;
	return (
		placeholder / tokens.length >= 0.6 &&
		/\b(?:loading|please wait|enable javascript)\b/i.test(compact)
	);
}

export function emptyContentError(html: string) {
	return emptyShellMarkers.test(html) || looksLikeAppShell(html)
		? "app shell without static text"
		: "empty content";
}

export function reportedNotFoundError(
	markdown: string,
	title: string | undefined,
) {
	const titleText = title?.trim();
	const lines = markdown
		.split(/\n+/)
		.map((line) => line.replace(/^#{1,6}\s*/, "").trim())
		.filter(Boolean)
		.slice(0, 4);
	const content = titleText && lines[0] === titleText ? lines.slice(1) : lines;
	return /^404:?\s*this page could not be found\.?$/i.test(content[0] ?? "") &&
		/^this page could not be found\.?$/i.test(content[1] ?? "")
		? "page reported not found"
		: undefined;
}

export function looksLikeAppShell(html: string): boolean {
	if (discoveryShellMarkers.test(html)) return true;
	try {
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
	} catch {
		return false;
	}
}

export function chromeHeading(text: string) {
	return /^(our api|hello world|support|sign in|search(?: developer site)?)$/i.test(
		text,
	);
}

export function blockedAccessError(
	markdown: string,
	title: string | undefined,
	html = "",
) {
	return (
		clientChallengeError(markdown, title, html) ??
		(accessGate(markdown, title, html) ? "blocked by access gate" : undefined)
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

function clientChallengeError(
	markdown: string,
	title: string | undefined,
	html: string,
) {
	return /client challenge/i.test(title ?? "") ||
		/required part of this site couldn.t load/i.test(markdown) ||
		isCloudflareChallenge(markdown, title, html)
		? "blocked by client challenge"
		: undefined;
}

function isCloudflareChallenge(
	markdown: string,
	title: string | undefined,
	html: string,
) {
	if (wordCount(markdown) > 80) return false;
	const text = whitespaceKey([title ?? "", markdown].join(" "));
	const marker =
		/cdn-cgi\/challenge-platform|cf-browser-verification|cf-challenge|_cf_chl_opt/i.test(
			html,
		);
	if (!marker && !/\bjust a moment\b/i.test(text)) return false;
	return /\bchecking if the site connection is secure\b|\benable javascript and cookies to continue\b|\bplease stand by\b/i.test(
		text,
	);
}

function accessGate(markdown: string, title: string | undefined, html: string) {
	const compact = whitespaceKey([title ?? "", markdown].join(" "));
	const words = wordCount(markdown);
	if (words > 160) return false;
	if (strongGateLanguage(compact)) return true;
	return (
		words <= 60 &&
		gateTitle(title) &&
		(formLikeGate(html) || actionOnlyGate(markdown))
	);
}

function strongGateLanguage(text: string) {
	return /\b(?:complete the security check|paywall|please log in|please sign in|sign in to continue|subscribe to continue|verify (?:you are human|your identity))\b/i.test(
		text,
	);
}

function gateTitle(title: string | undefined) {
	return /^(?:access denied|log in|login|sign in|subscribe|verify you are human)$/i.test(
		(title ?? "").trim(),
	);
}

function formLikeGate(html: string) {
	return /<form\b|type=["'](?:email|password)["']|name=["'](?:email|login|password|username)["']|(?:g-recaptcha|hcaptcha|cf-turnstile)/i.test(
		html,
	);
}

function actionOnlyGate(markdown: string) {
	return /\b(?:continue with (?:github|google|microsoft)|create account|email address|forgot password|password|remember me|sign in|log in)\b/i.test(
		markdown,
	);
}

function placeholderText(markdown: string) {
	return markdown
		.replace(/\u2026/g, " ")
		.replace(/[#*_`[\]()]/g, " ")
		.replace(/[^\p{Letter}\p{Number}]+/gu, " ")
		.toLowerCase()
		.trim();
}

function markerPattern(sources: string[]) {
	return new RegExp(sources.join("|"), "i");
}

const loadingPlaceholderWords = new Set([
	"docs",
	"documentation",
	"enable",
	"javascript",
	"js",
	"loads",
	"loading",
	"wait",
	"waiting",
]);
const loadingStopWords = new Set([
	"a",
	"an",
	"and",
	"app",
	"for",
	"in",
	"of",
	"please",
	"run",
	"the",
	"this",
	"to",
	"you",
	"your",
]);
