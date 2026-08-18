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
	const port = Number(
		resolved.url.port || (resolved.url.protocol === "https:" ? 443 : 80),
	);
	const lookup = pinnedLookup(address);
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
		const rejectOnce = (cause: unknown) => {
			if (settled) return;
			settled = true;
			cleanup();
			reject(cause);
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
					// Redirect bodies are never consumed. Closing the response keeps an
					// attacker from streaming outside the byte and wall-clock limits after
					// the caller has already moved on to the next hop.
					if (res.socket) res.socket.destroy();
					else res.destroy();
					resolveOnce({ url: raw, status, headers, body: new Uint8Array() });
					return;
				}
				void readIncoming(res, maxBytes)
					.then((body) =>
						resolveOnce({
							url: raw,
							status,
							headers,
							body: decodeContent(
								body,
								res.headers["content-encoding"]?.toString(),
								maxBytes,
							),
						}),
					)
					.catch(rejectOnce);
			},
		);
		const abort = (error: Error) => {
			req.destroy(error);
			rejectOnce(error);
		};
		req.on("error", rejectOnce);
		if (signal) {
			const onAbort = () => {
				const error =
					signal.reason instanceof Error
						? signal.reason
						: new Error("request aborted");
				abort(error);
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
		deadline = setTimeout(() => abort(deadlineError()), deadlineMs);
		req.on("timeout", () => abort(new Error("request timed out")));
		req.end();
	});
}

export function pinnedLookup(address: PublicAddress): LookupFunction {
	const lookup: LookupFunction = (_hostname, options, callback) => {
		if (options.all) {
			callback(null, [{ address: address.address, family: address.family }]);
			return;
		}
		callback(null, address.address, address.family);
	};
	return lookup;
}

function deadlineError() {
	// "timed out" keeps this non-retryable per retry.ts and classified as timeout
	return new Error("request timed out: whole-request deadline exceeded");
}

export function decodeContent(
	body: Uint8Array,
	contentEncoding: string | undefined,
	maxBytes: number,
): Uint8Array {
	const encodings = (contentEncoding ?? "")
		.split(",")
		.map((value) => value.trim().toLowerCase())
		.filter((value) => value && value !== "identity");
	if (encodings.length === 0) return body;
	const options = { maxOutputLength: maxBytes };
	let decoded = body;
	for (const encoding of encodings.reverse()) {
		if (encoding === "br") decoded = brotliDecompressSync(decoded, options);
		else if (encoding === "gzip" || encoding === "x-gzip") {
			decoded = gunzipSync(decoded, options);
		} else if (encoding === "deflate") {
			decoded = inflateSync(decoded, options);
		} else {
			throw new Error(`unsupported content encoding: ${encoding}`);
		}
	}
	return decoded;
}

function responseHeaders(response: IncomingMessage): HeaderMap {
	const headers = new Headers();
	for (const [name, value] of Object.entries(response.headers)) {
		if (Array.isArray(value)) {
			for (const item of value) headers.append(name, item);
		} else if (value !== undefined) {
			headers.set(name, value);
		}
	}
	return headers;
}

async function readIncoming(
	response: IncomingMessage,
	maxBytes: number,
): Promise<Uint8Array> {
	const chunks: Buffer[] = [];
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
	return Buffer.concat(chunks, bytes);
}
