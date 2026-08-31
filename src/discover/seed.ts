import { hasMarkdownBody } from "../core/text.ts";
import type {
	ConditionalRequest,
	DiscoveredUrl,
	PipelineConfig,
} from "../core/types.ts";
import { classifyDiscoveryResource, isDocumentPath } from "../core/url.ts";
import { isRecoverableAppShell } from "../extract/app-shell.ts";
import { isMarkdownLike } from "../extract/content.ts";
import { fetchText, preferredMarkdownAccept } from "../fetch/fetcher.ts";
import type { Robots } from "./robots.ts";
import { normalizeDiscoveryResourceUrl, normalizeUrl } from "./url.ts";

const markdownProbeHedgeMs = 40;

export function seedInputUrl(raw: string) {
	const resource = classifyDiscoveryResource(raw);
	if (resource) return resource.url;
	const normalized = normalizeUrl(raw) ?? normalizeDiscoveryResourceUrl(raw);
	return normalized ? withRequestedSearch(raw, normalized) : raw;
}

export async function pageOnlyDiscovery(
	config: PipelineConfig,
	inputSeed: string,
	seedRobots: Robots,
	pageConditional?: ConditionalRequest,
): Promise<DiscoveredUrl[]> {
	const pageSeed = withRequestedSearch(config.seedUrl, inputSeed);
	if (config.perOrigin < 2) {
		const alternate = await markdownAlternateSeed(
			config,
			pageSeed,
			seedRobots,
			pageConditional,
		);
		return [
			alternate ?? (await fetchPageSeed(config, pageSeed, pageConditional)),
		];
	}
	const controller = new AbortController();
	const started: Promise<unknown>[] = [];
	try {
		const alternatePromise = markdownAlternateSeed(
			config,
			pageSeed,
			seedRobots,
			pageConditional,
			controller.signal,
		);
		started.push(alternatePromise);
		const earlyAlternate = await Promise.race([
			alternatePromise,
			Bun.sleep(markdownProbeHedgeMs),
		]);
		if (earlyAlternate) return [earlyAlternate];

		const pagePromise = fetchPageSeed(
			config,
			pageSeed,
			pageConditional,
			controller.signal,
		);
		started.push(pagePromise);
		const winner = await Promise.race([
			pagePromise.then((page) => ({ page })),
			alternatePromise.then((alternate) => ({ alternate })),
		]);
		if ("alternate" in winner) {
			return [winner.alternate ?? (await pagePromise)];
		}
		if (usablePageSeed(winner.page)) return [winner.page];
		return [(await alternatePromise) ?? winner.page];
	} finally {
		controller.abort();
		await Promise.allSettled(started);
	}
}

function usablePageSeed(page: DiscoveredUrl) {
	const response = page.fetched;
	return Boolean(
		response?.ok &&
			(response.notModified ||
				response.document ||
				(hasMarkdownBody(response.body) &&
					!isRecoverableAppShell(response.body))),
	);
}

async function fetchPageSeed(
	config: PipelineConfig,
	pageSeed: string,
	conditional?: ConditionalRequest,
	signal?: AbortSignal,
	preferMarkdown = true,
): Promise<DiscoveredUrl> {
	const options = signal ? { signal } : undefined;
	let fetched = await fetchText(
		pageSeed,
		config,
		preferMarkdown ? preferredMarkdownAccept : undefined,
		conditional,
		undefined,
		options,
	);
	if (
		preferMarkdown &&
		fetched.ok &&
		!fetched.notModified &&
		!fetched.document &&
		isMarkdownLike(fetched) &&
		!hasMarkdownBody(fetched.body)
	) {
		fetched = await fetchText(
			pageSeed,
			config,
			undefined,
			conditional,
			undefined,
			options,
		);
	}
	return {
		url: pageSeed,
		source: "seed",
		wasSeed: true,
		fetched,
	};
}

async function markdownAlternateSeed(
	config: PipelineConfig,
	pageSeed: string,
	seedRobots: Robots,
	conditional?: ConditionalRequest,
	signal?: AbortSignal,
): Promise<DiscoveredUrl | undefined> {
	const alternate = markdownAlternateUrl(pageSeed);
	if (!alternate || !seedRobots.allowed(alternate)) return;
	const origin = new URL(pageSeed).origin;
	const response = await fetchText(
		alternate,
		config,
		preferredMarkdownAccept,
		conditional,
		(url) => new URL(url).origin === origin && seedRobots.allowed(url),
		signal
			? { followRouteFallbacks: false, signal }
			: { followRouteFallbacks: false },
	);
	if (!response.ok) return;
	if (
		!response.notModified &&
		(!isMarkdownLike(response) || !hasMarkdownBody(response.body))
	)
		return;
	return { url: alternate, source: "seed", wasSeed: true, fetched: response };
}

function markdownAlternateUrl(raw: string): string | undefined {
	const url = new URL(raw);
	if (
		url.search ||
		/\.(?:md|mdx|txt)$/i.test(url.pathname) ||
		isDocumentPath(url.pathname)
	)
		return;
	url.pathname = url.pathname.endsWith("/")
		? `${url.pathname}index.md`
		: `${url.pathname}.md`;
	return normalizeUrl(url.href);
}

export function seedFirstCorpus(
	seed: DiscoveredUrl,
	corpus: DiscoveredUrl[],
	config: PipelineConfig,
	limit = config.max,
): DiscoveredUrl[] {
	const seedMetadata =
		seed.metadata ?? corpus.find((item) => item.url === seed.url)?.metadata;
	const first: DiscoveredUrl = { ...seed };
	if (seedMetadata) first.metadata = seedMetadata;
	const out: DiscoveredUrl[] = [first];
	const seen = new Set([seed.url]);
	for (const item of corpus) {
		if (seen.has(item.url)) continue;
		if (config.maxExplicit && out.length >= limit) break;
		seen.add(item.url);
		out.push(item);
	}
	return out;
}

function withRequestedSearch(raw: string, normalized: string) {
	try {
		const requested = new URL(raw);
		if (!requested.search) return normalized;
		const seed = new URL(normalized);
		seed.search = requested.search;
		return seed.href;
	} catch {
		return normalized;
	}
}
