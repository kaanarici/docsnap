import type { HttpResponse } from "./transport.ts";

export type Cookie = {
	name: string;
	value: string;
	domain: string;
	hostOnly: boolean;
	secure: boolean;
};

export function cookieHeader(cookies: Cookie[], raw: string) {
	const url = new URL(raw);
	const host = url.hostname.toLowerCase();
	return cookies
		.filter(
			(cookie) =>
				(!cookie.secure || url.protocol === "https:") &&
				(cookie.hostOnly
					? cookie.domain === host
					: host === cookie.domain || host.endsWith(`.${cookie.domain}`)),
		)
		.map((cookie) => `${cookie.name}=${cookie.value}`)
		.join("; ");
}

export function storeCookies(
	cookies: Cookie[],
	raw: string,
	response: HttpResponse,
) {
	const host = new URL(raw).hostname.toLowerCase();
	const values = response.headers.getSetCookie?.() ?? [
		response.headers.get("set-cookie") ?? "",
	];
	for (const value of values) {
		const parts = value.split(";").map((part) => part.trim());
		const pair = parts[0];
		if (!pair) continue;
		const split = pair.indexOf("=");
		if (split <= 0) continue;
		const rawDomain = parts
			.find((part) => /^domain=/i.test(part))
			?.slice("domain=".length)
			.replace(/^\./, "")
			.toLowerCase();
		const acceptedDomain =
			rawDomain &&
			domainMatches(host, rawDomain) &&
			!isRejectedCookieDomain(rawDomain)
				? rawDomain
				: undefined;
		const domain = acceptedDomain ?? host;
		const cookie = {
			name: pair.slice(0, split),
			value: pair.slice(split + 1),
			domain,
			hostOnly: acceptedDomain === undefined,
			secure: parts.some((part) => /^secure$/i.test(part)),
		};
		const index = cookies.findIndex(
			(item) => item.name === cookie.name && item.domain === cookie.domain,
		);
		if (index >= 0) cookies[index] = cookie;
		else cookies.push(cookie);
	}
}

function domainMatches(host: string, domain: string) {
	return (
		domain.includes(".") && (host === domain || host.endsWith(`.${domain}`))
	);
}

const publicSuffixCookieDomains = new Set([
	"ac.uk",
	"co.in",
	"co.jp",
	"co.nz",
	"co.uk",
	"co.za",
	"com.au",
	"com.br",
	"com.mx",
	"gov.uk",
	"net.au",
	"org.au",
	"org.uk",
]);

const sharedHostCookieDomains = new Set([
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
]);

function isRejectedCookieDomain(domain: string) {
	return (
		publicSuffixCookieDomains.has(domain) || sharedHostCookieDomains.has(domain)
	);
}
