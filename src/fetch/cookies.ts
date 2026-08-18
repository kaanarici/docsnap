import type { HttpResponse } from "./transport.ts";

export type Cookie = {
	name: string;
	value: string;
	domain: string;
	path: string;
	secure: boolean;
};

export function cookieHeader(cookies: Cookie[], raw: string) {
	const url = new URL(raw);
	const host = url.hostname.toLowerCase();
	return cookies
		.filter(
			(cookie) =>
				(!cookie.secure || url.protocol === "https:") &&
				cookie.domain === host &&
				pathMatches(url.pathname, cookie.path),
		)
		.sort((a, b) => b.path.length - a.path.length)
		.map((cookie) => `${cookie.name}=${cookie.value}`)
		.join("; ");
}

export function storeCookies(
	cookies: Cookie[],
	raw: string,
	response: HttpResponse,
) {
	const url = new URL(raw);
	const host = url.hostname.toLowerCase();
	const requestPath = url.pathname;
	const values = response.headers.getSetCookie?.() ?? [
		response.headers.get("set-cookie") ?? "",
	];
	for (const value of values) {
		const parts = value.split(";").map((part) => part.trim());
		const pair = parts[0];
		if (!pair) continue;
		const split = pair.indexOf("=");
		if (split <= 0) continue;
		const pathAttribute = parts
			.slice(1)
			.find((part) => /^path=/i.test(part))
			?.slice(5);
		const cookie = {
			name: pair.slice(0, split),
			value: pair.slice(split + 1),
			domain: host,
			path:
				pathAttribute?.startsWith("/") === true
					? pathAttribute
					: defaultPath(requestPath),
			secure: parts.some((part) => /^secure$/i.test(part)),
		};
		const index = cookies.findIndex(
			(item) =>
				item.name === cookie.name &&
				item.domain === cookie.domain &&
				item.path === cookie.path,
		);
		if (index >= 0) cookies[index] = cookie;
		else cookies.push(cookie);
	}
}

function pathMatches(pathname: string, cookiePath: string) {
	return (
		pathname === cookiePath ||
		(pathname.startsWith(cookiePath) &&
			(cookiePath.endsWith("/") || pathname[cookiePath.length] === "/"))
	);
}

function defaultPath(pathname: string) {
	const end = pathname.lastIndexOf("/");
	return end <= 0 ? "/" : pathname.slice(0, end);
}
