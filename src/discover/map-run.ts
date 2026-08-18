import { discoveryAttemptLimit } from "../core/config.ts";
import { candidateKey } from "../core/identity.ts";
import type {
	DiscoveredUrl,
	DiscoveryResourceSeed,
	FetchedUrl,
	PipelineConfig,
} from "../core/types.ts";
import { isRecoverableAppShell } from "../extract/app-shell.ts";
import { fetchMany } from "../fetch/fetcher.ts";
import type { ChromiumRenderer } from "../render/chromium.ts";
import { startDiscovery } from "./index.ts";
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

function releaseSuccessfulFetch(item: DiscoveredUrl): DiscoveredUrl {
	if (!item.fetched?.ok) return item;
	const { fetched: _fetched, ...released } = item;
	return released;
}
