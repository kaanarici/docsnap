import type { Config, RedirectHop } from "../core/types.ts";
import { type Cookie, cookieHeader, storeCookies } from "../fetch/cookies.ts";
import {
	type FetchTransport,
	type HttpResponse,
	requestPublicHttp,
} from "../fetch/transport.ts";
import type { RenderPagePolicy, RenderRequest } from "./policy.ts";

export type PausedRenderRequest = {
	requestId: string;
	resourceType?: string;
	isNavigationRequest?: boolean;
	request: {
		url: string;
		method?: string;
		headers?: Record<string, string>;
	};
};

export type FetchCommand =
	| {
			method: "Fetch.fulfillRequest";
			params: {
				requestId: string;
				responseCode: number;
				responseHeaders: Array<{ name: string; value: string }>;
				body: string;
			};
	  }
	| {
			method: "Fetch.failRequest";
			params: { requestId: string; errorReason: "BlockedByClient" };
	  };

export type FetchCommandSender = (
	method: FetchCommand["method"],
	params: FetchCommand["params"],
) => Promise<void>;

export type RenderFulfillmentOptions = {
	transport?: FetchTransport;
	maxRedirects?: number;
	pagePolicy?: RenderPagePolicy;
	resourceType?: string;
	isNavigationRequest?: boolean;
};

const defaultMaxRedirects = 8;

export async function handlePausedRenderRequest(
	params: PausedRenderRequest,
	pagePolicy: RenderPagePolicy,
	config: Config,
	send: FetchCommandSender,
	options: RenderFulfillmentOptions = {},
): Promise<"fulfilled" | "failed"> {
	const decision = await pagePolicy.decide({
		url: params.request.url,
		...(params.request.method !== undefined
			? { method: params.request.method }
			: {}),
		...(params.resourceType ? { resourceType: params.resourceType } : {}),
		...(params.isNavigationRequest !== undefined
			? { isNavigationRequest: params.isNavigationRequest }
			: {}),
	});
	if (!decision.allow) {
		await failRequest(send, params.requestId);
		return "failed";
	}
	try {
		const response = await fetchRenderResponse(params.request, config, {
			...options,
			pagePolicy,
			...(params.resourceType ? { resourceType: params.resourceType } : {}),
			...(params.isNavigationRequest !== undefined
				? { isNavigationRequest: params.isNavigationRequest }
				: {}),
		});
		await send("Fetch.fulfillRequest", {
			requestId: params.requestId,
			responseCode: response.status,
			responseHeaders: response.headers,
			body: response.body,
		});
		return "fulfilled";
	} catch {
		await failRequest(send, params.requestId);
		return "failed";
	}
}

export async function fetchRenderResponse(
	request: PausedRenderRequest["request"],
	config: Config,
	options: RenderFulfillmentOptions = {},
) {
	if ((request.method ?? "GET").toUpperCase() !== "GET") {
		throw new Error("blocked non-GET request");
	}
	const transport = options.transport ?? requestPublicHttp;
	const maxRedirects = options.maxRedirects ?? defaultMaxRedirects;
	const cookies: Cookie[] = [];
	const redirects: RedirectHop[] = [];
	const seen = new Set<string>();
	let current = request.url;
	for (let redirectCount = 0; ; redirectCount++) {
		const response = await transport(
			current,
			requestHeaders(request, config, current, cookies),
			config,
		);
		storeCookies(cookies, current, response);
		const next = redirectTarget(response, current);
		if (!next)
			return fulfillmentFrom(response, current, request.url, redirects);
		if (redirectCount >= maxRedirects || seen.has(next)) {
			throw new Error("too many redirects");
		}
		const decision = await options.pagePolicy?.decide(
			policyRequest(request, next, options),
		);
		if (decision && !decision.allow) throw new Error(decision.reason);
		const hop = redirectHop(current, next, response.status);
		if (hop) redirects.push(hop);
		seen.add(next);
		current = next;
	}
}

function requestHeaders(
	request: PausedRenderRequest["request"],
	config: Config,
	currentUrl: string,
	cookies: Cookie[],
): Record<string, string> {
	const accept = headerValue(request.headers, "accept") ?? "*/*";
	const cookie =
		cookieHeader(cookies, currentUrl) || browserCookie(request, currentUrl);
	const referer = safeHttpHeaderUrl(headerValue(request.headers, "referer"));
	return {
		accept,
		"user-agent": config.userAgent,
		...(cookie ? { cookie } : {}),
		...(referer ? { referer } : {}),
	};
}

function browserCookie(
	request: PausedRenderRequest["request"],
	currentUrl: string,
): string | undefined {
	if (currentUrl !== request.url || !sameOrigin(currentUrl, request.url))
		return;
	return headerValue(request.headers, "cookie");
}

function fulfillmentFrom(
	response: HttpResponse,
	finalUrl: string,
	requestUrl: string,
	redirects: RedirectHop[],
) {
	return {
		status:
			response.status >= 100 && response.status <= 599 ? response.status : 502,
		headers: responseHeaders(response, sameOrigin(finalUrl, requestUrl)),
		body: Buffer.from(response.body).toString("base64"),
		finalUrl: cleanHttpUrl(finalUrl) ?? requestUrl,
		redirects,
	};
}

function responseHeaders(response: HttpResponse, includeSetCookie: boolean) {
	const headers: Array<{ name: string; value: string }> = [];
	const contentType = response.headers.get("content-type");
	if (contentType) headers.push({ name: "content-type", value: contentType });
	if (includeSetCookie) {
		for (const cookie of response.headers.getSetCookie?.() ?? []) {
			headers.push({ name: "set-cookie", value: cookie });
		}
	}
	return headers;
}

function policyRequest(
	request: PausedRenderRequest["request"],
	url: string,
	options: RenderFulfillmentOptions,
): RenderRequest {
	return {
		url,
		...(request.method !== undefined ? { method: request.method } : {}),
		...(options.resourceType ? { resourceType: options.resourceType } : {}),
		...(options.isNavigationRequest !== undefined
			? { isNavigationRequest: options.isNavigationRequest }
			: {}),
	};
}

function redirectHop(
	from: string,
	to: string,
	status: number,
): RedirectHop | undefined {
	const cleanFrom = cleanHttpUrl(from);
	const cleanTo = cleanHttpUrl(to);
	if (!cleanFrom || !cleanTo) return;
	return { from: cleanFrom, to: cleanTo, type: "http", status };
}

function redirectTarget(
	response: HttpResponse,
	base: string,
): string | undefined {
	if (response.status < 300 || response.status > 399) return undefined;
	const location = response.headers.get("location");
	if (!location) return undefined;
	const next = new URL(location, base);
	if (next.protocol !== "http:" && next.protocol !== "https:") {
		throw new Error("unsafe redirect scheme");
	}
	next.hash = "";
	return next.href;
}

function cleanHttpUrl(raw: string): string | undefined {
	try {
		const url = new URL(raw);
		if (url.protocol !== "http:" && url.protocol !== "https:") return;
		url.username = "";
		url.password = "";
		url.hash = "";
		return url.href;
	} catch {
		return;
	}
}

function sameOrigin(left: string, right: string) {
	try {
		return new URL(left).origin === new URL(right).origin;
	} catch {
		return false;
	}
}

async function failRequest(send: FetchCommandSender, requestId: string) {
	await send("Fetch.failRequest", {
		requestId,
		errorReason: "BlockedByClient",
	});
}

function headerValue(
	headers: Record<string, string> | undefined,
	name: string,
): string | undefined {
	if (!headers) return undefined;
	const lower = name.toLowerCase();
	for (const [key, value] of Object.entries(headers)) {
		if (key.toLowerCase() === lower && value.trim()) return value;
	}
	return undefined;
}

function safeHttpHeaderUrl(value: string | undefined): string | undefined {
	if (!value) return undefined;
	try {
		const url = new URL(value);
		url.username = "";
		url.password = "";
		url.hash = "";
		return url.protocol === "http:" || url.protocol === "https:"
			? url.href
			: undefined;
	} catch {
		return undefined;
	}
}
