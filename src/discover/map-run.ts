import { discoveryAttemptLimit } from "../core/config.ts";
import { candidateKey } from "../core/identity.ts";
import type {
	DiscoveredUrl,
	DiscoveryResourceSeed,
	FetchedUrl,
	PipelineConfig,
} from "../core/types.ts";
import { fetchMany } from "../fetch/fetcher.ts";
import {
	type ChromeSession,
	chromeBudgetMs,
	chromeStopped,
	closeChromeSession,
	createChromeSession,
	needsChromeFetch,
	renderChromePage,
	skipChrome,
} from "../render/session.ts";
import { startDiscovery } from "./index.ts";
import { discoverFetchedResources } from "./nav.ts";
import { normalizeUrl } from "./url.ts";

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

export async function discoverMap(
	config: PipelineConfig,
): Promise<DiscoveryRun> {
	const attemptLimit = discoveryAttemptLimit(config);
	const limit = config.max;
	const session = await startDiscovery(config, undefined, attemptLimit);
	const urls: DiscoveredUrl[] = [];
	const seen = new Set<string>();
	const scheduled = new Set<string>();
	const chrome = createChromeSession();
	const errors: NonNullable<DiscoveryRenderSummary["errors"]> = [];
	let renderDeadline: number | undefined;
	const renderQueue: FetchedUrl[] = [];
	const queuedRender = new Set<string>();
	let slots = 0;
	let pulled = 0;
	let exhausted = false;
	try {
		const pending: DiscoveredUrl[] = [];
		const known = new Set<string>();
		while (known.size < limit) {
			config.signal?.throwIfAborted();
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
			config.signal?.throwIfAborted();
			const batchSize = Math.min(config.perOrigin, limit - slots);
			const pulledBatch =
				pending.length > 0
					? pending.splice(0, batchSize)
					: await session.frontier.take(batchSize);
			if (pulledBatch.length === 0) {
				const page = !chromeStopped(chrome) && renderQueue.shift();
				if (page) {
					renderDeadline ??= performance.now() + chromeBudgetMs(config, limit);
					const rendered = chrome.rendered;
					const queued = session.frontier.queued;
					await renderDiscoveryShell(
						page,
						config,
						chrome,
						errors,
						renderDeadline,
					);
					if (chrome.rendered > rendered) {
						session.frontier.observe(page.result);
						chrome.misses =
							session.frontier.queued > queued ? 0 : chrome.misses + 1;
					} else chrome.misses++;
					if (chromeStopped(chrome)) {
						if (!chrome.unavailable) {
							skipChrome(
								chrome,
								renderQueue.length,
								chrome.stopReason ?? "no_new_urls",
							);
						} else skipChrome(chrome, renderQueue.length);
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
					session.frontier.observe(
						page.result,
						discoverFetchedResources(page.result),
					);
					if (page.result.ok) {
						scheduled.add(candidateKey(page.result.finalUrl));
					}
					if (
						!normalizeUrl(page.result.finalUrl) ||
						!needsChromeFetch(page.result)
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
		await closeChromeSession(chrome);
	}
	const render = mapRenderSummary(chrome, errors);
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
	chrome: ChromeSession,
	errors: NonNullable<DiscoveryRenderSummary["errors"]>,
	deadline: number,
) {
	const remaining = deadline - performance.now();
	const rendered = await renderChromePage(chrome, page, config, remaining);
	if (!rendered) return;
	if (rendered.ok && rendered.result.ok) {
		page.result = rendered.result;
		chrome.rendered++;
		return;
	}
	chrome.failed++;
	const error = rendered.ok ? rendered.result.error : rendered.error;
	if (errors.length < 5) {
		errors.push({
			url: rendered.ok ? rendered.result.finalUrl : page.result.finalUrl,
			kind: rendered.ok ? "render" : rendered.kind,
			error: (error ?? "Client render failed").slice(0, 300),
		});
	}
}

function mapRenderSummary(
	chrome: ChromeSession,
	errors: NonNullable<DiscoveryRenderSummary["errors"]>,
): DiscoveryRenderSummary {
	const stopReason =
		chrome.stopReason === "budget" || chrome.stopReason === "no_new_urls"
			? chrome.stopReason
			: undefined;
	const summary: DiscoveryRenderSummary = {
		attempted: chrome.attempted,
		rendered: chrome.rendered,
		failed: chrome.failed,
		skipped: chrome.skipped,
		truncated: chrome.truncated,
	};
	if (stopReason) summary.stopReason = stopReason;
	if (chrome.unavailable) summary.unavailable = chrome.unavailable;
	if (errors.length) summary.errors = errors;
	return summary;
}

function releaseSuccessfulFetch(item: DiscoveredUrl): DiscoveredUrl {
	if (!item.fetched?.ok) return item;
	const { fetched: _fetched, ...released } = item;
	return released;
}
