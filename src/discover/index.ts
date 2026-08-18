import { discoveryAttemptLimit } from "../core/config.ts";
import { candidateKey } from "../core/identity.ts";
import type {
	ConditionalRequest,
	DiscoveredUrl,
	DiscoveryResourceSeed,
	FetchedUrl,
	FetchResult,
	PipelineConfig,
} from "../core/types.ts";
import {
	classifyDiscoveryResource,
	isLlmsResourcePath,
	looksLikeSpecificContentUrl,
	scopeFromFeedResource,
} from "../core/url.ts";
import {
	isLanguageSelector,
	isRecoverableAppShell,
} from "../extract/app-shell.ts";
import {
	type FetchUrlGate,
	fetchMany,
	fetchText,
	preferredMarkdownAccept,
} from "../fetch/fetcher.ts";
import { emptyResourceResult } from "../fetch/result.ts";
import type { ChromiumRenderer } from "../render/chromium.ts";
import {
	discoverLlmsCorpus,
	type LlmsCorpusOptions,
	resourceAllowed,
} from "./corpus.ts";
import { discoverFeed, isFeedResponse } from "./feed.ts";
import {
	createDiscoveryFrontier,
	type DiscoveryFrontier,
	type DiscoveryFrontierInput,
	staticDiscoveryFrontier,
} from "./frontier.ts";
import { discoverPageResources } from "./nav.ts";
import { loadRobots } from "./robots.ts";
import { pageOnlyDiscovery, seedFirstCorpus, seedInputUrl } from "./seed.ts";
import {
	chooseScope,
	normalizeDiscoveryResourceUrl,
	normalizeUrl,
	scopeFromSeed,
} from "./url.ts";

type DiscoveryRun = {
	urls: DiscoveredUrl[];
	seedResource?: DiscoveryResourceSeed;
	render?: DiscoveryRenderSummary;
	complete?: boolean;
	truncated?: boolean;
};

type DiscoveryRenderSummary = {
	attempted: number;
	rendered: number;
	failed: number;
	skipped: number;
	truncated: boolean;
	stopReason?: "budget" | "no_new_urls";
	unavailable?: string;
	errors?: Array<{
		url: string;
		kind: "timeout" | "render";
		error: string;
	}>;
};

export type DiscoverySession = {
	frontier: DiscoveryFrontier;
	allowResource?: FetchUrlGate;
	seedResource?: DiscoveryResourceSeed;
};

type RawDiscovery = DiscoveryRun | DiscoverySession;

export async function discoverMap(
	config: PipelineConfig,
): Promise<DiscoveryRun> {
	const attemptLimit = discoveryAttemptLimit(config);
	const limit = config.max;
	const session = await startDiscovery(config, undefined, attemptLimit);
	const urls: DiscoveredUrl[] = [];
	const seen = new Set<string>();
	const scheduled = new Set<string>();
	const render: DiscoveryRenderSummary = {
		attempted: 0,
		rendered: 0,
		failed: 0,
		skipped: 0,
		truncated: false,
	};
	let renderer: ChromiumRenderer | undefined;
	let renderDeadline: number | undefined;
	const renderQueue: FetchedUrl[] = [];
	const queuedRender = new Set<string>();
	let slots = 0;
	let pulled = 0;
	let exhausted = false;
	let renderMisses = 0;
	try {
		const pending: DiscoveredUrl[] = [];
		const known = new Set<string>();
		while (known.size < limit) {
			const batch = await session.frontier.take(limit - known.size);
			if (batch.length === 0) break;
			pending.push(...batch);
			for (const item of batch) {
				if (!item.fetched || item.fetched.ok) {
					known.add(candidateKey(item.fetched?.finalUrl ?? item.url));
				}
			}
		}
		const expand = session.allowResource !== undefined && known.size < limit;
		while (slots < limit) {
			const batchSize = Math.min(config.perOrigin, limit - slots);
			const pulledBatch =
				pending.length > 0
					? pending.splice(0, batchSize)
					: await session.frontier.take(batchSize);
			if (pulledBatch.length === 0) {
				const page =
					!render.stopReason && !render.unavailable && renderQueue.shift();
				if (page) {
					renderDeadline ??=
						performance.now() +
						Math.min(120_000, Math.max(config.timeoutMs, limit * 1_500));
					const rendered = render.rendered;
					const queued = session.frontier.queued;
					renderer = await renderDiscoveryShell(
						page,
						config,
						render,
						renderer,
						renderDeadline,
					);
					if (render.rendered > rendered) {
						session.frontier.observe(page.result);
						renderMisses =
							session.frontier.queued > queued ? 0 : renderMisses + 1;
					} else renderMisses++;
					if (render.unavailable || renderMisses >= 3 || render.stopReason) {
						if (!render.unavailable) {
							render.truncated = true;
							render.stopReason ??= "no_new_urls";
						}
						render.skipped += renderQueue.length;
						renderQueue.length = 0;
					}
					continue;
				}
				exhausted = true;
				break;
			}
			pulled += pulledBatch.length;
			const batch = pulledBatch.filter((item) => {
				const key = candidateKey(item.url);
				if (scheduled.has(key)) return false;
				scheduled.add(key);
				return true;
			});
			if (batch.length === 0) continue;
			const fetched = expand
				? await fetchMany(batch, config, undefined, session.allowResource)
				: undefined;
			if (fetched) {
				for (const page of fetched) {
					session.frontier.observe(page.result);
					if (page.result.ok) {
						scheduled.add(candidateKey(page.result.finalUrl));
					}
					if (
						!page.result.ok ||
						page.result.notModified ||
						!normalizeUrl(page.result.finalUrl) ||
						!isRecoverableAppShell(page.result.body)
					)
						continue;
					const key = candidateKey(page.result.finalUrl);
					if (queuedRender.has(key)) continue;
					queuedRender.add(key);
					renderQueue.push(page);
				}
			}
			for (const [index, item] of batch.entries()) {
				const result = fetched?.[index]?.result ?? item.fetched;
				const keys = [
					candidateKey(item.url),
					...(result?.ok ? [candidateKey(result.finalUrl)] : []),
				];
				if (keys.some((key) => seen.has(key))) continue;
				for (const key of keys) seen.add(key);
				urls.push(
					result && !result.ok
						? { ...item, fetched: result }
						: releaseSuccessfulFetch(item),
				);
				if (
					(!result || result.ok) &&
					(config.maxExplicit || item.source !== "llms")
				) {
					slots++;
				}
				if (slots >= limit) break;
			}
		}
	} finally {
		await renderer?.close();
	}
	const result: DiscoveryRun = {
		urls,
		truncated: session.frontier.truncated || render.truncated,
		complete:
			exhausted &&
			pulled < attemptLimit &&
			!session.frontier.truncated &&
			urls.every((entry) => !entry.fetched || entry.fetched.ok) &&
			render.failed === 0 &&
			!render.truncated,
	};
	if (session.seedResource) result.seedResource = session.seedResource;
	if (render.attempted || render.truncated) result.render = render;
	return result;
}

async function renderDiscoveryShell(
	page: FetchedUrl,
	config: PipelineConfig,
	summary: DiscoveryRenderSummary,
	renderer: ChromiumRenderer | undefined,
	deadline: number,
) {
	const remaining = deadline - performance.now();
	if (remaining <= 0) {
		summary.truncated = true;
		summary.stopReason = "budget";
		return renderer;
	}
	summary.attempted++;
	if (!renderer) {
		const opened = await import("../render/chromium.ts").then((module) =>
			module.openChromiumRenderer(config),
		);
		if (!opened.ok) {
			summary.unavailable = opened.error;
			summary.failed++;
			return;
		}
		renderer = opened.renderer;
	}
	const rendered = await renderer.renderPage(page.result, {
		explicitSeed: page.wasSeed === true,
		signal: AbortSignal.timeout(
			Math.max(1, Math.min(config.timeoutMs, Math.ceil(remaining))),
		),
	});
	summary.truncated ||= rendered.metrics.truncated;
	if (rendered.ok && rendered.result.ok) {
		page.result = rendered.result;
		summary.rendered++;
	} else {
		const error = rendered.ok ? rendered.result.error : rendered.error;
		summary.failed++;
		summary.errors ??= [];
		if (summary.errors.length < 5) {
			summary.errors.push({
				url: rendered.ok ? rendered.result.finalUrl : page.result.finalUrl,
				kind: rendered.ok ? "render" : rendered.kind,
				error: (error ?? "Client render failed").slice(0, 300),
			});
		}
	}
	return renderer;
}

export async function startDiscovery(
	config: PipelineConfig,
	pageConditional?: ConditionalRequest,
	attemptLimit = config.max,
): Promise<DiscoverySession> {
	const raw = await discoverRawRun(config, pageConditional, attemptLimit);
	if ("frontier" in raw) return raw;
	const session: DiscoverySession = {
		frontier: staticDiscoveryFrontier(
			raw.urls,
			Boolean(raw.truncated) || raw.complete === false,
		),
	};
	if (raw.seedResource) session.seedResource = raw.seedResource;
	return session;
}

async function discoverRawRun(
	config: PipelineConfig,
	pageConditional?: ConditionalRequest,
	attemptLimit = config.max,
): Promise<RawDiscovery> {
	const inputSeed = seedInputUrl(config.seedUrl);
	const seedRobots = await loadRobots(new URL(inputSeed).origin, config);

	if (config.pageOnly) {
		return {
			urls: await pageOnlyDiscovery(
				config,
				inputSeed,
				seedRobots,
				pageConditional,
			),
		};
	}

	const llmsOptions: LlmsCorpusOptions = { cache: new Map() };

	const seedIsLlms = classifyDiscoveryResource(inputSeed)?.source === "llms";
	if (seedIsLlms) {
		llmsOptions.cache?.set(
			inputSeed,
			fetchText(inputSeed, config, preferredMarkdownAccept),
		);
	}
	const overlapSeed =
		!seedIsLlms && config.concurrency > 1 && config.perOrigin > 1;
	const seedResponsePromise = overlapSeed
		? fetchText(inputSeed, config)
		: undefined;
	const corpus = await resolveLlmsCorpus(
		config,
		inputSeed,
		overlapSeed
			? {
					...llmsOptions,
					initialFetchLimit: Math.min(config.concurrency, config.perOrigin) - 1,
				}
			: llmsOptions,
		attemptLimit,
	);
	if ("done" in corpus && seedIsLlms) {
		const done = corpus.done.map((item) =>
			item.url === inputSeed ? { ...item, wasSeed: true as const } : item,
		);
		if (done.length === 0) {
			const response = await llmsOptions.cache?.get(inputSeed);
			return {
				urls: [await explicitLlmsSeedFailure(config, inputSeed, response)],
				truncated: Boolean(llmsOptions.truncated),
			};
		}
		const response = await llmsOptions.cache?.get(inputSeed);
		const seedResource: DiscoveryResourceSeed = {
			url: inputSeed,
			finalUrl:
				(response && normalizeDiscoveryResourceUrl(response.finalUrl)) ??
				inputSeed,
			source: "llms",
		};
		return {
			urls: done,
			seedResource,
			truncated: Boolean(llmsOptions.truncated),
		};
	}

	const seedResponse = await (seedResponsePromise ??
		fetchText(inputSeed, config));
	if ("done" in corpus) {
		return {
			urls: seedFirstCorpus(
				seedEntry(
					normalizeUrl(seedResponse.finalUrl) ?? inputSeed,
					"seed",
					seedResponse,
				),
				corpus.done,
				config,
				attemptLimit,
			),
			truncated: Boolean(llmsOptions.truncated),
		};
	}
	if (!seedResponse.ok) {
		return { urls: [seedEntry(inputSeed, "seed", seedResponse)] };
	}

	if (isFeedResponse(seedResponse)) {
		const feedSeed =
			normalizeDiscoveryResourceUrl(seedResponse.finalUrl) ?? inputSeed;
		const seedResource: DiscoveryResourceSeed = {
			url: inputSeed,
			finalUrl: feedSeed,
			source: "feed",
		};
		const robots = await loadRobots(new URL(feedSeed).origin, config);
		const feed = await discoverFeed(
			feedSeed,
			feedSeed,
			scopeFromFeedResource(feedSeed),
			config,
			{
				limit: attemptLimit,
				response: seedResponse,
				accept: robots.allowed,
			},
		);
		if (feed.pages.length > 0) {
			return { urls: feed.pages, seedResource, truncated: feed.truncated };
		}
		return {
			urls: [
				seedEntry(
					feedSeed,
					"feed",
					emptyResourceResult(
						seedResponse,
						"feed resource did not list any in-scope pages",
					),
				),
			],
			seedResource,
		};
	}

	const resolved = await resolveHtmlSeed(
		config,
		inputSeed,
		seedResponse,
		corpus.llmsOut,
		llmsOptions,
		attemptLimit,
	);
	if ("done" in resolved) {
		return { urls: resolved.done, truncated: Boolean(llmsOptions.truncated) };
	}
	return resolved;
}

async function explicitLlmsSeedFailure(
	config: PipelineConfig,
	inputSeed: string,
	seedResponse?: FetchResult,
): Promise<DiscoveredUrl> {
	const response =
		seedResponse ??
		(await fetchText(inputSeed, config, preferredMarkdownAccept));
	return seedEntry(
		inputSeed,
		"llms",
		response.ok
			? emptyResourceResult(
					response,
					"llms resource did not list any in-scope pages",
				)
			: response,
	);
}

async function resolveLlmsCorpus(
	config: PipelineConfig,
	inputSeed: string,
	llmsOptions: LlmsCorpusOptions,
	attemptLimit: number,
): Promise<{ done: DiscoveredUrl[] } | { llmsOut: DiscoveredUrl[] }> {
	const inputUrl = new URL(inputSeed);
	if (classifyDiscoveryResource(inputSeed)?.source === "llms") {
		return {
			done: await discoverLlmsCorpus(
				inputSeed,
				inputSeed,
				"/",
				config,
				llmsOptions,
				attemptLimit,
			),
		};
	}
	if (deferInitialLlms(config, inputSeed)) return { llmsOut: [] };

	const inputScope = scopeFromSeed(inputSeed);
	const llmsOut = await discoverLlmsCorpus(
		inputSeed,
		inputSeed,
		inputScope,
		config,
		llmsOptions,
		attemptLimit,
	);
	const substantivePageCount = llmsOut.filter((item) => {
		const path = new URL(item.url).pathname;
		return !isLlmsResourcePath(path);
	}).length;
	if (
		inputScope !== "/" &&
		llmsOut.length <= Math.min(config.max, 3) &&
		substantivePageCount < 2
	) {
		const root = `${inputUrl.origin}/`;
		const rootLlmsOut = await discoverLlmsCorpus(
			root,
			inputSeed,
			inputScope,
			config,
			llmsOptions,
			attemptLimit,
		);
		if (rootLlmsOut.length > llmsOut.length) return { done: rootLlmsOut };
	}
	if (inputScope === "/" ? llmsOut.length > 0 : hasCorpus(llmsOut, config)) {
		return { done: llmsOut };
	}
	return { llmsOut };
}

async function resolveHtmlSeed(
	config: PipelineConfig,
	inputSeed: string,
	seedResponse: FetchResult,
	llmsOut: DiscoveredUrl[],
	llmsOptions: LlmsCorpusOptions,
	attemptLimit: number,
): Promise<{ done: DiscoveredUrl[] } | DiscoverySession> {
	const inputScope = scopeFromSeed(inputSeed);
	const finalSeed = normalizeUrl(seedResponse.finalUrl);
	const seed = finalSeed ?? inputSeed;
	const seedResources = discoverPageResources(
		seedResponse.body,
		seedResponse.finalUrl,
		true,
	);
	const seedIsLanguageSelector = isLanguageSelector(
		seedResponse.finalUrl,
		seedResponse.body,
	);
	const scope = seedIsLanguageSelector
		? "/"
		: chooseScope(inputScope, seed, seedResources.links);
	const robots = await loadRobots(new URL(seed).origin, config);

	let redirected: DiscoveredUrl[] | undefined;
	if (!deferInitialLlms(config, inputSeed)) {
		if (seed !== inputSeed || scope !== inputScope) {
			const adjusted = await discoverLlmsCorpus(
				seed,
				seed,
				scope,
				config,
				llmsOptions,
				attemptLimit,
			);
			if (hasCorpus(adjusted, config)) redirected = adjusted;
		}
		const seedUrl = new URL(seed);
		const inputUrl = new URL(inputSeed);
		if (
			!redirected &&
			!seedUrl.pathname.endsWith("/") &&
			inputUrl.pathname.split("/").filter(Boolean).length === 1
		) {
			const sameOrigin = seedUrl.origin === inputUrl.origin;
			const root = await discoverLlmsCorpus(
				seed,
				sameOrigin ? inputSeed : seed,
				sameOrigin ? inputScope : "/",
				config,
				llmsOptions,
				attemptLimit,
			);
			if (root.length > llmsOut.length) redirected = root;
		}
	}
	if (redirected) {
		return {
			done: seedFirstCorpus(
				seedEntry(seed, "seed", seedResponse),
				redirected,
				config,
				attemptLimit,
			),
		};
	}

	const context: DiscoveryFrontierInput = {
		config,
		attemptLimit,
		seed,
		scope,
		robots,
		allowResource: (url) => resourceAllowed(url, config),
		llmsOptions,
		seedResponse,
		seedResources,
		seedIsLanguageSelector,
		finalSeed,
		inputSeed,
	};
	return {
		frontier: createDiscoveryFrontier(context),
		allowResource: context.allowResource,
	};
}

function hasCorpus(out: DiscoveredUrl[], config: PipelineConfig) {
	return out.length >= Math.min(config.max, config.maxExplicit ? 3 : 2);
}

function deferInitialLlms(config: PipelineConfig, seed: string) {
	return config.maxExplicit && looksLikeSpecificContentUrl(seed);
}

function seedEntry(
	url: string,
	source: DiscoveredUrl["source"],
	fetched: FetchResult,
): DiscoveredUrl {
	return { url, source, wasSeed: true, fetched };
}

function releaseSuccessfulFetch(item: DiscoveredUrl): DiscoveredUrl {
	if (!item.fetched?.ok) return item;
	const { fetched: _fetched, ...released } = item;
	return released;
}
