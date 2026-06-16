import type { Config, FetchResult } from "../core/types.ts";
import { relatedHost } from "../core/url.ts";
import { type FetchUrlGate, fetchText } from "../fetch/fetcher.ts";
import type { Robots } from "./robots.ts";
import { normalizeUrl } from "./url.ts";

// bare apex domains often refuse connections on /robots.txt while the
// canonical www origin serves both content and robots; one bounded seed fetch
// finds that origin, and discovery restarts there robots-first. Only a
// cross-origin redirect target counts — same-origin means genuinely closed.
// When the seed itself fails, the fetch failure is returned so the run
// reports the real network error instead of a robots block.
// allowResource gates the probe so a cross-origin redirect target's body is
// never fetched before that origin's robots policy is loaded and allows it.
export async function canonicalOriginSeed(
	inputSeed: string,
	config: Config,
	allowResource?: FetchUrlGate,
): Promise<{ moved?: string; failure?: FetchResult }> {
	const response = await fetchText(
		inputSeed,
		config,
		undefined,
		undefined,
		allowResource,
	);
	if (!response.ok) return { failure: response };
	const finalUrl = normalizeUrl(response.finalUrl);
	if (!finalUrl) return {};
	const from = new URL(inputSeed);
	const to = new URL(finalUrl);
	if (to.origin === from.origin) return {};
	if (!relatedHost(from.hostname, to.hostname)) return {};
	return { moved: finalUrl };
}

export function literalAllowPrefix(
	robots: Robots,
	inputSeed: string,
): string | undefined {
	const origin = new URL(inputSeed).origin;
	const literals = robots.allows
		.map((rule) => rule.value)
		.filter(
			(value) =>
				value.startsWith("/") &&
				value.endsWith("/") &&
				value.length > 1 &&
				!value.includes("*") &&
				!value.includes("$"),
		)
		.sort((a, b) => b.length - a.length);
	const best = literals[0];
	if (!best) return undefined;
	const url = normalizeUrl(`${origin}${best}`);
	return url && robots.allowed(url) ? url : undefined;
}
