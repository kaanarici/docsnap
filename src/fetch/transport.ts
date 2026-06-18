import type { IncomingMessage } from "node:http";
import { Agent as HttpAgent, request as httpRequest } from "node:http";
import { Agent as HttpsAgent, request as httpsRequest } from "node:https";
import type { LookupFunction } from "node:net";
import { brotliDecompressSync, gunzipSync, inflateSync } from "node:zlib";
import type {
	FetchTransport,
	HeaderMap,
	HttpResponse,
	PipelineConfig,
} from "../core/types.ts";
import {
	type PublicAddress,
	type PublicHttpAddress,
	resolvePublicHttpUrl,
} from "../security/url.ts";

export type { FetchTransport, HeaderMap, HttpResponse };

const httpAgent = new HttpAgent({ keepAlive: true, maxSockets: 64 });
const httpsAgent = new HttpsAgent({ keepAlive: true, maxSockets: 64 });

type Resolver = typeof resolvePublicHttpUrl;

// requestPublicHttp performs real DNS resolution; the only thing tests need to
// substitute is that resolution so they can drive the real transport against a
// loopback server while presenting a public hostname. This is the sole test
// seam left in the transport and it is reset between tests.
let testResolver: Resolver | undefined;

export function setResolvePublicHttpUrlForTest(
	resolver: Resolver | undefined,
): void {
	testResolver = resolver;
}

export async function requestPublicHttp(
	raw: string,
	headers: Record<string, string>,
	config: PipelineConfig,
): Promise<HttpResponse> {
	const resolved = await (testResolver ?? resolvePublicHttpUrl)(raw);
	const deadlineAt = Date.now() + config.timeoutMs * 3;
	let lastError: unknown;
	for (const address of resolved.addresses) {
		const remainingMs = deadlineAt - Date.now();
		if (remainingMs <= 0) throw deadlineError();
		try {
			return await requestAddress(
				raw,
				headers,
				config,
				resolved,
				address,
				remainingMs,
			);
		} catch (error) {
			lastError = error;
		}
	}
	throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function requestAddress(
	raw: string,
	headers: Record<string, string>,
	config: PipelineConfig,
	resolved: PublicHttpAddress,
	address: PublicAddress,
	deadlineMs: number,
): Promise<HttpResponse> {
	const request =
		resolved.url.protocol === "https:" ? httpsRequest : httpRequest;
	const port =
		resolved.url.port === ""
			? resolved.url.protocol === "https:"
				? 443
				: 80
			: Number(resolved.url.port);
	const lookup = ((_hostname: string, options: unknown, callback?: unknown) => {
		const done = typeof options === "function" ? options : callback;
		if (typeof done !== "function") throw new Error("missing DNS callback");
		if (typeof options === "function") {
			done(null, address.address, address.family);
			return;
		}
		if (
			options &&
			typeof options === "object" &&
			"all" in options &&
			options.all === true
		) {
			done(null, [{ address: address.address, family: address.family }]);
			return;
		}
		done(null, address.address, address.family);
	}) as LookupFunction;
	return new Promise((resolve, reject) => {
		const req = request(
			{
				protocol: resolved.url.protocol,
				hostname: resolved.hostname,
				port,
				path: `${resolved.url.pathname}${resolved.url.search}`,
				method: "GET",
				headers: { ...headers, "accept-encoding": "gzip, deflate, br" },
				agent: resolved.url.protocol === "https:" ? httpsAgent : httpAgent,
				lookup,
				servername:
					resolved.hostname === address.address ? undefined : resolved.hostname,
				timeout: config.timeoutMs,
			},
			(res) => {
				void readIncoming(res, config.maxBytes)
					.then((body) => decodeContent(body, res, config.maxBytes))
					.then((body) =>
						resolve({
							url: raw,
							status: res.statusCode ?? 0,
							headers: responseHeaders(res),
							body,
						}),
					)
					.catch((error) => reject(deadlineHit ? deadlineError() : error))
					.finally(() => clearTimeout(deadline));
			},
		);
		// the socket timeout above is idle-based; a server trickling bytes resets
		// it forever, so a whole-request wall-clock deadline bounds the worst case
		let deadlineHit = false;
		const deadline = setTimeout(() => {
			deadlineHit = true;
			req.destroy(deadlineError());
		}, deadlineMs);
		req.on("timeout", () => req.destroy(new Error("request timed out")));
		req.on("error", (error) => {
			clearTimeout(deadline);
			reject(deadlineHit ? deadlineError() : error);
		});
		req.end();
	});
}

function deadlineError() {
	// "timed out" keeps this non-retryable per retry.ts and classified as timeout
	return new Error("request timed out: whole-request deadline exceeded");
}

function decodeContent(
	body: Uint8Array,
	response: IncomingMessage,
	maxBytes: number,
): Uint8Array {
	const encoding = response.headers["content-encoding"]
		?.toString()
		.toLowerCase();
	if (!encoding || encoding === "identity") return body;
	const options = { maxOutputLength: maxBytes };
	if (encoding.includes("br")) return brotliDecompressSync(body, options);
	if (encoding.includes("gzip") || encoding.includes("x-gzip")) {
		return gunzipSync(body, options);
	}
	if (encoding.includes("deflate")) return inflateSync(body, options);
	return body;
}

function responseHeaders(response: IncomingMessage): HeaderMap {
	const headers = new Headers();
	const setCookie: string[] = [];
	for (const [name, value] of Object.entries(response.headers)) {
		if (Array.isArray(value)) {
			for (const item of value) {
				headers.append(name, item);
				if (name.toLowerCase() === "set-cookie") setCookie.push(item);
			}
		} else if (value !== undefined) {
			headers.set(name, value);
			if (name.toLowerCase() === "set-cookie") setCookie.push(value);
		}
	}
	return {
		get: (name) => headers.get(name),
		getSetCookie: () => setCookie,
	};
}

async function readIncoming(
	response: IncomingMessage,
	maxBytes: number,
): Promise<Uint8Array> {
	if (
		response.statusCode &&
		response.statusCode >= 300 &&
		response.statusCode <= 399
	) {
		response.resume();
		return new Uint8Array();
	}
	const chunks: Uint8Array[] = [];
	let bytes = 0;
	for await (const chunk of response) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		bytes += buffer.byteLength;
		if (bytes > maxBytes) {
			response.destroy();
			throw new Error(`response exceeds ${maxBytes} bytes`);
		}
		chunks.push(buffer);
	}
	const body = new Uint8Array(bytes);
	let offset = 0;
	for (const chunk of chunks) {
		body.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return body;
}
