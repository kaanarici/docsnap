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
		if (isFeedResourceUrl(url)) return { url: url.href, source: "feed" };
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
		segments.length >= 3 ||
		(segments.length >= 2 && !url.pathname.endsWith("/"))
	);
}

export function siteDiscoverySeedUrl(raw: string): string {
	const url = new URL(raw);
	url.hash = "";
	url.search = "";
	const parts = url.pathname.split("/").filter(Boolean);
	if (parts.length > 0) parts.pop();
	url.pathname = parts.length ? `/${parts.join("/")}/` : "/";
	return url.href;
}

export function scopeFromFeedResource(seed: string): string {
	const url = new URL(seed);
	if (url.searchParams.has("feed")) {
		if (url.pathname === "/" || url.pathname === "") return "/";
		if (url.pathname.endsWith("/")) return url.pathname;
		if (!/\.[a-z0-9]+$/i.test(url.pathname)) return url.pathname;
	}
	const parts = url.pathname.split("/").filter(Boolean);
	if (isFeedResourceUrl(url)) {
		const last = parts.at(-1)?.toLowerCase() ?? "";
		if (/^(?:feed|rss|atom)$/.test(last)) parts.pop();
		else if (/^(?:feed|rss|atom)\.xml$/.test(last)) parts.pop();
		else if (/\.(?:rss|atom)$/.test(last)) parts.pop();
	}
	return parts.length > 0 ? `/${parts.join("/")}/` : "/";
}

export function isLlmsResourcePath(pathname: string): boolean {
	return /\/llms(?:-[^/]+)?\.(?:md|txt)$/i.test(pathname);
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

export function sameSiteLabel(left: string, right: string): boolean {
	const a = siteLabel(withoutWww(left));
	const b = siteLabel(withoutWww(right));
	return a !== "" && a === b;
}

function withoutWww(hostname: string): string {
	return hostname.toLowerCase().replace(/^www\./, "");
}

const sharedHostSuffixes = [
	"appspot.com",
	"cloudflarepages.com",
	"firebaseapp.com",
	"fly.dev",
	"github.io",
	"gitlab.io",
	"glitch.me",
	"herokuapp.com",
	"netlify.app",
	"pages.dev",
	"readthedocs.io",
	"replit.app",
	"surge.sh",
	"vercel.app",
	"web.app",
];

function isSharedHostTenant(hostname: string): boolean {
	return sharedHostSuffixes.some(
		(suffix) => hostname === suffix || hostname.endsWith(`.${suffix}`),
	);
}

function siteLabel(hostname: string): string {
	const parts = hostname.split(".").filter(Boolean);
	if (parts.length < 2) return "";
	const suffix = publicSuffixes.find(
		(item) => hostname === item || hostname.endsWith(`.${item}`),
	);
	if (suffix) {
		if (hostname === suffix) return "";
		return parts.at(-(suffix.split(".").length + 1)) ?? "";
	}
	return parts.at(-2) ?? "";
}

function isFeedResourceUrl(url: URL): boolean {
	const pathname = url.pathname.toLowerCase();
	return (
		/(?:^|\/)(?:feed|rss|atom)(?:\/|$)/i.test(pathname) ||
		/(?:^|\/)(?:rss|feed|atom)\.xml$/i.test(pathname) ||
		/\.(?:rss|atom)$/i.test(pathname) ||
		url.searchParams.has("feed")
	);
}

const publicSuffixes = [
	"ac.uk",
	"co.in",
	"co.jp",
	"co.nz",
	"co.uk",
	"com.au",
	"com.br",
	"com.mx",
	"gov.uk",
	"net.au",
	"org.au",
	"org.uk",
];
