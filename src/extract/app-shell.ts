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
const appMountIds = [
	"app",
	"root",
	"__next",
	"__nuxt",
	"__docusaurus",
	"___gatsby",
];
const appMountIdSource = `(?:${appMountIds.join("|")})`;
const appMountIdMarker = `id=["']${appMountIdSource}["']`;
const appMountSelector = appMountIds.map((id) => `#${id}`).join(",");
export const appShellDom = {
	mount: appMountSelector,
	primary: "app-root,main,[role=main],article",
	meaningful: "h1,h2,h3,article,pre,table,[role=main]",
	loading: String.raw`\b(?:enable javascript|initializing|just a moment|loading|please wait|prepar(?:ed|ing))\b`,
} as const;
const emptyAppMountMarker = new RegExp(
	String.raw`<([a-z][\w:-]*)\b[^>]*\b${appMountIdMarker}[^>]*>\s*<\/\1\s*>`,
	"i",
);
const shellPlaceholderMarkers = markerPattern([
	...shellFrameworkMarkers,
	rawGithubMarker,
]);
export function isShellPlaceholder(
	markdown: string,
	title: string | undefined,
	html: string,
) {
	const sameAsTitle =
		title !== undefined &&
		markdown.replace(/^#+\s*/, "").trim() === title.trim();
	return (
		(((Boolean(title) && sameAsTitle) ||
			(wordCount(markdown) <= 2 &&
				/raw\.githubusercontent\.com|xhrPromise/i.test(html))) &&
			shellPlaceholderMarkers.test(html)) ||
		(/^\s*search\s*$/i.test(markdown) &&
			/<input[^>]+type=["']search["']|placeholder=["']search["']|class=["'][^"']*search/i.test(
				html,
			) &&
			/__docusaurus/i.test(html)) ||
		(sameAsTitle && emptyAppMountMarker.test(html))
	);
}

export function isLoadingShellPlaceholder(markdown: string, shell: boolean) {
	if (!shell) return false;
	const compact = placeholderText(markdown);
	if (!compact || wordCount(compact) > 16 || compact.length > 180) {
		return false;
	}
	if (
		/\b(?:you need to enable javascript to run this app|initializing|just a moment|please wait|prepar(?:ed|ing))\b/i.test(
			compact,
		)
	) {
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

export function reportedNotFoundError(
	markdown: string,
	title: string | undefined,
) {
	const titleText = title?.trim();
	if (
		/^(?:(?:article|page|post) not found|404)$/i.test(titleText ?? "") &&
		wordCount(markdown) < 80 &&
		(/(?:could not|couldn't|cannot|can't|unable to) (?:be found|find)\b/i.test(
			markdown,
		) ||
			/\b(?:page|document|url)\b[^\n]{0,80}\bdoes not exist\b/i.test(markdown))
	) {
		return "page reported not found";
	}
	const lines = contentLines(markdown, titleText, 4);
	return /^404:?\s*this page could not be found\.?$/i.test(lines[0] ?? "") &&
		/^this page could not be found\.?$/i.test(lines[1] ?? "")
		? "page reported not found"
		: undefined;
}

export function isRecoverableAppShell(html: string, dom?: Document): boolean {
	if (emptyAppMountMarker.test(html)) return true;
	try {
		const document = dom ?? parseHTML(html).document;
		const scriptCount = document.querySelectorAll(
			"script,link[rel~='modulepreload'],link[rel~='preload'][as='script']",
		).length;
		if (scriptCount === 0) return false;
		const primary =
			document.querySelector(appShellDom.mount) ??
			document.querySelector(appShellDom.primary) ??
			document.body;
		const text = shellText(primary);
		const meaningful = Array.from(
			primary?.querySelectorAll(appShellDom.meaningful) ?? [],
		).some((node) => shellText(node).length > 0);
		return text.length < 500 && !meaningful;
	} catch {
		return false;
	}
}

function shellText(root: Node | undefined | null) {
	if (!root) return "";
	const chunks: string[] = [];
	const stack: Node[] = [root];
	while (stack.length > 0) {
		const node = stack.pop()!;
		if (node.nodeType === 3) chunks.push(node.textContent ?? "");
		else if (!/^(?:script|style|noscript)$/i.test(node.nodeName)) {
			for (let index = node.childNodes.length - 1; index >= 0; index--) {
				const child = node.childNodes[index];
				if (child) stack.push(child);
			}
		}
	}
	return whitespaceKey(chunks.join(""));
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

function clientChallengeError(
	markdown: string,
	title: string | undefined,
	html: string,
) {
	return /client challenge/i.test(title ?? "") ||
		/required part of this site couldn.t load/i.test(markdown) ||
		(/(?:\/|\b)anubis(?:\/|\b)/i.test(`${markdown}\n${html}`) &&
			/ensure the security of your connection/i.test(markdown)) ||
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
	const ambiguous = ambiguousGatePattern.test(compact);
	if (ambiguous && gateTitle(title)) return true;
	if (words > 160) return false;
	if (ambiguous && formLikeGate(html)) return true;
	if (
		/\b(?:complete the security check|paywall|verif(?:y|ying) (?:you are (?:a )?human|your identity))\b/i.test(
			compact,
		)
	)
		return true;
	if (ambiguous && standaloneGateCopy(markdown, title)) return true;
	return (
		words <= 60 &&
		gateTitle(title) &&
		(formLikeGate(html) || actionOnlyGate(markdown))
	);
}

function standaloneGateCopy(markdown: string, title: string | undefined) {
	const lines = contentLines(markdown, title);
	return lines.length === 1 && standaloneGatePattern.test(lines[0]!);
}

function contentLines(
	markdown: string,
	title: string | undefined,
	limit = Number.POSITIVE_INFINITY,
) {
	const lines = markdown
		.split(/\n+/)
		.map((line) => line.replace(/^#{1,6}\s*/, "").trim())
		.filter(Boolean)
		.slice(0, limit);
	if (lines[0]?.toLowerCase() === title?.trim().toLowerCase()) lines.shift();
	return lines;
}

const ambiguousGateSource =
	"(?:please log in(?: to continue)?|please sign in(?: to continue)?|sign in to continue|subscribe to continue)";
const ambiguousGatePattern = new RegExp(`\\b${ambiguousGateSource}\\b`, "i");
const standaloneGatePattern = new RegExp(`^${ambiguousGateSource}[.!]?$`, "i");

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
