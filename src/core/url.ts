export function dropFragmentAndQuery(url: URL): URL {
	url.hash = "";
	url.search = "";
	return url;
}

export function urlWithoutFragmentAndQuery(
	raw: string,
	base?: string | URL,
): string {
	return dropFragmentAndQuery(new URL(raw, base)).href;
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
