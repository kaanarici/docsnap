export function urlWithoutFragment(raw: string, base?: string | URL): string {
	const url = new URL(raw, base);
	url.hash = "";
	const search = canonicalUrlSearch(url);
	url.search = "";
	return `${url.href}${search}`;
}

export function canonicalUrlSearch(url: URL) {
	if (!url.search) return "";
	const params = [...url.searchParams.entries()].sort(([left], [right]) =>
		left < right ? -1 : left > right ? 1 : 0,
	);
	return `?${new URLSearchParams(params).toString()}`;
}

export function classifyDiscoveryResource(
	raw: string | URL,
	base?: string | URL,
): { url: string; source: "llms" | "feed" } | undefined {
	try {
		const url = new URL(raw, base);
		if (!["http:", "https:"].includes(url.protocol)) return undefined;
		if (url.username || url.password) return undefined;
		url.hash = "";
		url.pathname = url.pathname.replace(/\/{2,}/g, "/");
		if (!url.pathname) url.pathname = "/";
		if (isLlmsResourcePath(url.pathname))
			return { url: url.href, source: "llms" };
		const feedPath = feedResourceStart(url.pathname.split("/").filter(Boolean));
		if (feedPath >= 0 || url.searchParams.has("feed"))
			return { url: url.href, source: "feed" };
		return undefined;
	} catch {
		return undefined;
	}
}

export function looksLikeSpecificContentUrl(raw: string): boolean {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		return false;
	}
	const segments = url.pathname.split("/").filter(Boolean);
	if (segments.length === 0) return false;
	const last = segments[segments.length - 1] ?? "";
	return (
		/\.(?:html?|mdx?|txt|json|rst)$/i.test(last) ||
		isDocumentPath(last) ||
		segments.length >= 3 ||
		(segments.length >= 2 && !url.pathname.endsWith("/"))
	);
}

export function isDocumentPath(path: string) {
	return /\.(?:doc|docx|docm|ppt|pps|pot|pptx|pptm|ppsx|ppsm|xls|xlsx|xlsm|xlsb|odt|ods|odp|rtf|epub|csv|pdf)$/i.test(
		path,
	);
}

export function scopeFromFeedResource(seed: string): string {
	const url = new URL(seed);
	if (url.searchParams.has("feed")) {
		if (url.pathname === "/" || url.pathname === "") return "/";
		if (url.pathname.endsWith("/")) return url.pathname;
		if (!/\.[a-z0-9]+$/i.test(url.pathname)) return url.pathname;
	}
	const parts = url.pathname.split("/").filter(Boolean);
	const resourceStart = feedResourceStart(parts);
	if (resourceStart >= 0) parts.length = resourceStart;
	return parts.length > 0 ? `/${parts.join("/")}/` : "/";
}

export function isLlmsResourcePath(pathname: string): boolean {
	return /\/llms(?:-(?:full|ctx(?:-full)?))?\.(?:md|txt)$/i.test(pathname);
}

export function relatedHost(left: string, right: string): boolean {
	const a = withoutWww(left);
	const b = withoutWww(right);
	if (a === b) return true;
	if (isSharedHostTenant(a) || isSharedHostTenant(b)) return false;
	return a.endsWith(`.${b}`) || b.endsWith(`.${a}`);
}

export function sameSharedHostPlatform(left: string, right: string): boolean {
	const a = withoutWww(left);
	const b = withoutWww(right);
	return sharedHostSuffixes.some(
		(suffix) => a.endsWith(`.${suffix}`) && b.endsWith(`.${suffix}`),
	);
}

function withoutWww(hostname: string): string {
	return hostname.toLowerCase().replace(/^www\./, "");
}

const sharedHostSuffixes =
	"appspot.com cloudflarepages.com firebaseapp.com fly.dev github.io gitlab.io glitch.me herokuapp.com netlify.app pages.dev readthedocs.io replit.app surge.sh vercel.app web.app".split(
		" ",
	);

function isSharedHostTenant(hostname: string): boolean {
	return sharedHostSuffixes.some(
		(suffix) => hostname === suffix || hostname.endsWith(`.${suffix}`),
	);
}

function feedResourceStart(parts: string[]): number {
	const marker = parts.findIndex((part) =>
		/^(?:feed|feeds|rss|atom)$/i.test(part),
	);
	if (marker >= 0) return marker;
	const last = parts.at(-1) ?? "";
	return /^(?:feed|rss|atom)\d*(?:\.xml)?$/i.test(last) ||
		/\.(?:rss|atom)$/i.test(last)
		? parts.length - 1
		: -1;
}
