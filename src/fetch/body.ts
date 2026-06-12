import type { HttpResponse } from "./transport.ts";

export function decodeResponseBody(response: HttpResponse, body: Uint8Array) {
	for (const encoding of charsetCandidates(response, body)) {
		try {
			return new TextDecoder(encoding, { fatal: true }).decode(body);
		} catch {}
	}
	return new TextDecoder().decode(body);
}

function charsetCandidates(response: HttpResponse, body: Uint8Array): string[] {
	const seen = new Set<string>();
	const candidates = [
		bomEncoding(body),
		charsetFromContentType(response.headers.get("content-type")),
		charsetFromMeta(body),
		"utf-8",
	];
	return candidates.filter((candidate): candidate is string => {
		if (!candidate || seen.has(candidate)) return false;
		seen.add(candidate);
		return true;
	});
}

function bomEncoding(body: Uint8Array): string | undefined {
	if (body[0] === 0xef && body[1] === 0xbb && body[2] === 0xbf) return "utf-8";
	if (body[0] === 0xff && body[1] === 0xfe) return "utf-16le";
	if (body[0] === 0xfe && body[1] === 0xff) return "utf-16be";
	return undefined;
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
