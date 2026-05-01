import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

const blockedHostname = /(^|\.)localhost$/i;
const addressCacheTtlMs = 60_000;
const addressCache = new Map<
	string,
	{ address: string; family: 4 | 6; expires: number }
>();

export type PublicHttpAddress = {
	url: URL;
	hostname: string;
	address: string;
	family: 4 | 6;
};

export function validatePublicHttpUrl(raw: string): string | undefined {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		return "invalid URL";
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		return "URL must use http or https";
	}
	if (url.username || url.password) {
		return "URL credentials are not allowed";
	}
	const hostname = normalizedHostname(url);
	if (!hostname || blockedHostname.test(hostname)) {
		return "localhost URLs are not allowed";
	}
	if (!hostname.includes(".") && !isIP(hostname)) {
		return "single-label hostnames are not allowed";
	}
	const ipVersion = isIP(hostname);
	if (
		(ipVersion === 4 || ipVersion === 6) &&
		!isPublicIp(hostname, ipVersion)
	) {
		return "private or internal IP addresses are not allowed";
	}
	return undefined;
}

export async function assertPublicHttpUrl(raw: string): Promise<void> {
	await resolvePublicHttpUrl(raw);
}

export async function resolvePublicHttpUrl(
	raw: string,
): Promise<PublicHttpAddress> {
	const syntaxError = validatePublicHttpUrl(raw);
	if (syntaxError) throw new Error(syntaxError);

	const url = new URL(raw);
	const hostname = normalizedHostname(url);
	const ipVersion = isIP(hostname);
	if (ipVersion === 4 || ipVersion === 6) {
		return { url, hostname, address: hostname, family: ipVersion };
	}
	const cached = addressCache.get(hostname);
	if (cached && cached.expires > Date.now()) {
		return {
			url,
			hostname,
			address: cached.address,
			family: cached.family,
		};
	}

	const addresses = await lookup(hostname, { all: true, verbatim: true });
	if (addresses.length === 0) {
		throw new Error("hostname did not resolve");
	}
	for (const address of addresses) {
		if (
			(address.family === 4 || address.family === 6) &&
			!isPublicIp(address.address, address.family)
		) {
			throw new Error("hostname resolves to a private or internal address");
		}
	}
	const address = addresses.find(
		(item): item is { address: string; family: 4 | 6 } =>
			(item.family === 4 || item.family === 6) &&
			isPublicIp(item.address, item.family),
	);
	if (!address) throw new Error("hostname did not resolve to a public address");
	addressCache.set(hostname, {
		address: address.address,
		family: address.family,
		expires: Date.now() + addressCacheTtlMs,
	});
	return { url, hostname, address: address.address, family: address.family };
}

function normalizedHostname(url: URL): string {
	return url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
}

function isPublicIp(address: string, family: 4 | 6): boolean {
	if (family === 4) return isPublicIpv4(address);
	return isPublicIpv6(address);
}

function isPublicIpv4(address: string): boolean {
	const parts = address.split(".").map(Number);
	if (parts.length !== 4 || parts.some((part) => part < 0 || part > 255)) {
		return false;
	}
	const [a, b] = parts as [number, number, number, number];
	return !(
		a === 0 ||
		a === 10 ||
		a === 127 ||
		(a === 100 && b >= 64 && b <= 127) ||
		(a === 169 && b === 254) ||
		(a === 172 && b >= 16 && b <= 31) ||
		(a === 192 && b === 0 && parts[2] === 0) ||
		(a === 192 && b === 0 && parts[2] === 2) ||
		(a === 192 && b === 88 && parts[2] === 99) ||
		(a === 192 && b === 168) ||
		(a === 198 && (b === 18 || b === 19)) ||
		(a === 198 && b === 51 && parts[2] === 100) ||
		(a === 203 && b === 0 && parts[2] === 113) ||
		a >= 224
	);
}

function isPublicIpv6(address: string): boolean {
	const segments = ipv6Segments(address);
	if (!segments) return false;
	const mappedIpv4 = ipv4FromMappedIpv6(segments);
	if (mappedIpv4) return isPublicIpv4(mappedIpv4);
	const [first, second, third] = segments as [
		number,
		number,
		number,
		number,
		number,
		number,
		number,
		number,
	];
	return !(
		first < 0x2000 ||
		first > 0x3fff ||
		(first === 0x2001 && second === 0) ||
		(first === 0x2001 && second === 2 && third === 0) ||
		(first === 0x2001 && (second & 0xfff0) === 0x10) ||
		(first === 0x2001 && (second & 0xfff0) === 0x20) ||
		(first === 0x2001 && second === 0x0db8) ||
		first === 0x2002 ||
		(first === 0x3fff && second <= 0x0fff)
	);
}

function ipv6Segments(address: string): number[] | undefined {
	let value = address.toLowerCase();
	if (value.includes(".")) {
		const colon = value.lastIndexOf(":");
		const tail = value.slice(colon + 1);
		if (isIP(tail) !== 4) return undefined;
		const [a, b, c, d] = tail.split(".").map(Number) as [
			number,
			number,
			number,
			number,
		];
		value = `${value.slice(0, colon)}:${((a << 8) | b).toString(16)}:${(
			(c << 8) | d
		).toString(16)}`;
	}
	const halves = value.split("::");
	if (halves.length > 2) return undefined;
	const head = splitIpv6Half(halves[0] ?? "");
	const tail = splitIpv6Half(halves[1] ?? "");
	const missing = halves.length === 2 ? 8 - head.length - tail.length : 0;
	if (missing < 0) return undefined;
	const segments = [...head, ...Array(missing).fill(0), ...tail];
	return segments.length === 8 ? segments : undefined;
}

function splitIpv6Half(value: string): number[] {
	if (!value) return [];
	return value.split(":").map((part) => Number.parseInt(part, 16));
}

function ipv4FromMappedIpv6(segments: number[]): string | undefined {
	if (
		segments[0] !== 0 ||
		segments[1] !== 0 ||
		segments[2] !== 0 ||
		segments[3] !== 0 ||
		segments[4] !== 0 ||
		segments[5] !== 0xffff
	) {
		return undefined;
	}
	const high = segments[6]!;
	const low = segments[7]!;
	return [(high >> 8) & 0xff, high & 0xff, (low >> 8) & 0xff, low & 0xff].join(
		".",
	);
}
