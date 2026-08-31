import { isDocumentPath } from "../core/url.ts";
import type { HttpResponse } from "./transport.ts";

const documentContentType =
	/^(?:application\/(?:pdf|rtf|epub\+zip|msword|vnd\.(?:ms-[^;]+|openxmlformats-officedocument\.[^;]+|oasis\.opendocument\.[^;]+))|text\/(?:csv|rtf))(?:;|$)/i;

export function documentPayload(
	response: HttpResponse,
	body: Uint8Array,
): Uint8Array | undefined {
	const contentType = (response.headers.get("content-type") ?? "").trim();
	const path = new URL(response.url).pathname;
	const signature = hasDocumentSignature(body);
	if (
		/^(?:text\/html|application\/xhtml\+xml)(?:;|$)/i.test(contentType) &&
		!signature
	)
		return;
	if (
		!isDocumentPath(path) &&
		!documentContentType.test(contentType) &&
		!signature
	) {
		return;
	}
	return body;
}

export function decodeResponseBody(response: HttpResponse, body: Uint8Array) {
	const seen = new Set<string>();
	const candidates = [
		bomEncoding(body),
		charsetFromContentType(response.headers.get("content-type")),
		charsetFromMeta(body),
		"utf-8",
	].filter((candidate): candidate is string => {
		if (!candidate || seen.has(candidate)) return false;
		seen.add(candidate);
		return true;
	});
	for (const encoding of candidates) {
		try {
			return new TextDecoder(encoding, { fatal: true }).decode(body);
		} catch {}
	}
	return new TextDecoder().decode(body);
}

export function declaredCharset(contentType: string | null, head: string) {
	return charsetFromContentType(contentType) ?? charsetFromMetaText(head);
}

function bomEncoding(body: Uint8Array): string | undefined {
	if (body[0] === 0xef && body[1] === 0xbb && body[2] === 0xbf) return "utf-8";
	if (body[0] === 0xff && body[1] === 0xfe) return "utf-16le";
	if (body[0] === 0xfe && body[1] === 0xff) return "utf-16be";
	return undefined;
}

function hasDocumentSignature(body: Uint8Array) {
	return (
		asciiPrefix(body, "%PDF-") ||
		asciiPrefix(body, "{\\rtf") ||
		[0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1].every(
			(byte, index) => body[index] === byte,
		)
	);
}

function asciiPrefix(body: Uint8Array, prefix: string) {
	return [...prefix].every((char, index) => body[index] === char.charCodeAt(0));
}

function charsetFromContentType(
	contentType: string | null,
): string | undefined {
	return cleanCharset(
		contentType?.match(/\bcharset\s*=\s*("[^"]+"|'[^']+'|[^;\s]+)/i)?.[1],
	);
}

function charsetFromMeta(body: Uint8Array): string | undefined {
	const head = new TextDecoder("windows-1252").decode(
		body.subarray(0, Math.min(body.length, 4096)),
	);
	return charsetFromMetaText(head);
}

function charsetFromMetaText(head: string) {
	return cleanCharset(
		head.match(
			/<meta\b[^>]*\bcharset\s*=\s*("[^"]+"|'[^']+'|[^\s"'/>]+)/i,
		)?.[1] ??
			head.match(
				/<meta\b[^>]*\bcontent\s*=\s*["'][^"']*\bcharset\s*=\s*([^"'\s;/>]+)/i,
			)?.[1],
	);
}

function cleanCharset(value: string | undefined): string | undefined {
	if (!value) return;
	return value
		.trim()
		.replace(/^["']|["']$/g, "")
		.toLowerCase();
}
