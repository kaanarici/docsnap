import type { IncomingMessage } from "node:http";
import { Agent as HttpAgent, request as httpRequest } from "node:http";
import { Agent as HttpsAgent, request as httpsRequest } from "node:https";
import type { LookupFunction } from "node:net";
import { brotliDecompressSync, gunzipSync, inflateSync } from "node:zlib";
import type { HeaderMap, HttpResponse, PipelineConfig } from "../core/types.ts";
import {
	type PublicAddress,
	type PublicHttpAddress,
	resolvePublicHttpUrl,
} from "../security/url.ts";

export type { HeaderMap, HttpResponse };

const httpAgent = new HttpAgent({ keepAlive: true, maxSockets: 64 });
const httpsAgent = new HttpsAgent({ keepAlive: true, maxSockets: 64 });

export async function requestPublicHttp(
	raw: string,
	headers: Record<string, string>,
	config: PipelineConfig,
	options: { signal?: AbortSignal; maxBytes?: number } = {},
): Promise<HttpResponse> {
	options.signal?.throwIfAborted();
	const resolved = await resolvePublicHttpUrl(raw, options.signal);
	options.signal?.throwIfAborted();
	const deadlineAt = Date.now() + config.timeoutMs;
	const maxBytes = Math.min(
		config.maxBytes,
		options.maxBytes ?? config.maxBytes,
	);
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
				maxBytes,
				options.signal,
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
	maxBytes: number,
	signal?: AbortSignal,
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
		let settled = false;
		let deadline: ReturnType<typeof setTimeout> | undefined;
		let removeAbort = () => {};
		const cleanup = () => {
			if (deadline) clearTimeout(deadline);
			removeAbort();
		};
		const resolveOnce = (response: HttpResponse) => {
			if (settled) return;
			settled = true;
			cleanup();
			resolve(response);
		};
		const rejectOnce = (error: unknown) => {
			if (settled) return;
			settled = true;
			cleanup();
			reject(error);
		};
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
				signal,
				servername:
					resolved.hostname === address.address ? undefined : resolved.hostname,
				timeout: config.timeoutMs,
			},
			(res) => {
				const status = res.statusCode ?? 0;
				const headers = responseHeaders(res);
				if (status >= 300 && status <= 399) {
					res.resume();
					resolveOnce({ url: raw, status, headers, body: new Uint8Array() });
					return;
				}
				void readIncoming(res, maxBytes)
					.then((body) => decodeContent(body, res, maxBytes))
					.then((body) =>
						resolveOnce({
							url: raw,
							status,
							headers,
							body,
						}),
					)
					.catch(rejectOnce);
			},
		);
		req.on("error", rejectOnce);
		if (signal) {
			const onAbort = () => {
				const error =
					signal.reason instanceof Error
						? signal.reason
						: new Error("request aborted");
				req.destroy(error);
				rejectOnce(error);
			};
			signal.addEventListener("abort", onAbort, { once: true });
			removeAbort = () => signal.removeEventListener("abort", onAbort);
			if (signal.aborted) {
				onAbort();
				return;
			}
		}
		// the socket timeout above is idle-based; a server trickling bytes resets
		// it forever, so a whole-request wall-clock deadline bounds the worst case
		deadline = setTimeout(() => {
			const error = deadlineError();
			req.destroy(error);
			rejectOnce(error);
		}, deadlineMs);
		req.on("timeout", () => {
			const error = new Error("request timed out");
			req.destroy(error);
			rejectOnce(error);
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
