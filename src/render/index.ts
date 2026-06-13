import type {
	Config,
	FetchedUrl,
	FetchResult,
	PageRender,
	RenderReason,
	RenderSummary,
} from "../core/types.ts";
import {
	type BrowserBinary,
	type BrowserSession,
	browserLaunchFailureCount,
	findBrowserBinary,
	launchBrowser,
} from "./browser.ts";
import { ChromeRenderer } from "./page.ts";

type Progress = (message: string) => void;
export const BROWSER_LAUNCH_FAILURE_LIMIT = 2;
const browserLaunchUnavailableReason =
	"browser launch failed repeatedly; using static capture";

export type RenderCandidate = {
	input: FetchedUrl;
	reason: RenderReason;
};

export type RenderAttempt = {
	input: FetchedUrl;
	reason: RenderReason;
	page: RenderSummary["pages"][number];
	render?: PageRender;
	rendered?: FetchedUrl;
};

export type RenderPageOutput = {
	ok: boolean;
	result?: FetchResult;
	error?: string;
	renderMs: number;
	resourceRequests: number;
	blockedRequests: number;
	timedOut?: boolean;
	browser?: string;
};

export type RenderFunctionForTest = (
	candidate: RenderCandidate,
	config: Config,
) => Promise<RenderPageOutput>;

export type BrowserLauncherForTest = (
	binary: BrowserBinary,
) => Promise<BrowserSession>;

export type RenderState = {
	summary: RenderSummary;
	launchFailures: number;
};

let rendererForTest: RenderFunctionForTest | undefined;
let browserLauncherForTest: BrowserLauncherForTest | undefined;

export function setRendererForTest(
	renderer: RenderFunctionForTest | undefined,
) {
	rendererForTest = renderer;
}

export function setBrowserLauncherForTest(
	launcher: BrowserLauncherForTest | undefined,
) {
	browserLauncherForTest = launcher;
}

export function createRenderState(
	config: Config,
	progress?: Progress,
): RenderState & { progress?: Progress } {
	return {
		launchFailures: 0,
		summary: {
			mode: config.render,
			renderer: "chrome-cdp",
			browser: null,
			attempted: 0,
			renderedPages: 0,
			failedPages: 0,
			elapsedMs: 0,
			resourceRequests: 0,
			blockedRequests: 0,
			unavailableReason: null,
			pages: [],
		},
		...(progress ? { progress } : {}),
	};
}

export async function closeRenderState(state: RenderState): Promise<void> {
	const active = state as RenderState & { renderer?: ChromeRenderer };
	await active.renderer?.close();
}

export async function renderCandidates(
	candidates: RenderCandidate[],
	config: Config,
	state: RenderState & { progress?: Progress },
): Promise<RenderAttempt[]> {
	if (config.render === "never" || candidates.length === 0) return [];
	const remaining = renderLimit(config) - state.summary.attempted;
	if (remaining <= 0) return [];
	const selected = candidates.slice(0, remaining);
	const started = performance.now();
	const renderer = await ensureRenderer(config, state, selected);
	if (!renderer) {
		state.summary.elapsedMs = Number(
			(state.summary.elapsedMs + performance.now() - started).toFixed(1),
		);
		return [];
	}
	state.progress?.(
		`docsnap: rendering ${selected.length} pages with chrome-cdp`,
	);
	const out: RenderAttempt[] = [];
	for (const candidate of selected) {
		const pageStarted = performance.now();
		const output = await renderer.render(candidate, config);
		const renderMs = output.renderMs || performance.now() - pageStarted;
		const page = {
			url: candidate.input.result.finalUrl,
			reason: candidate.reason,
			ok: output.ok,
			renderMs: Number(renderMs.toFixed(1)),
			resourceRequests: output.resourceRequests,
			blockedRequests: output.blockedRequests,
			...(output.timedOut ? { timedOut: true } : {}),
			...(output.error ? { error: output.error } : {}),
		};
		state.summary.attempted++;
		state.summary.resourceRequests += output.resourceRequests;
		state.summary.blockedRequests += output.blockedRequests;
		state.summary.pages.push(page);
		if (output.browser) state.summary.browser = output.browser;
		if (output.ok && output.result) {
			state.summary.renderedPages++;
			out.push({
				input: candidate.input,
				reason: candidate.reason,
				page,
				render: renderMetadata(candidate.reason, output),
				rendered: {
					source: "render",
					...(candidate.input.metadata
						? { metadata: candidate.input.metadata }
						: {}),
					result: output.result,
				},
			});
		} else {
			state.summary.failedPages++;
			out.push({
				input: candidate.input,
				reason: candidate.reason,
				page,
				render: renderMetadata(candidate.reason, output),
			});
		}
	}
	state.summary.elapsedMs = Number(
		(state.summary.elapsedMs + performance.now() - started).toFixed(1),
	);
	return out;
}

async function ensureRenderer(
	config: Config,
	state: RenderState & { progress?: Progress },
	candidates: RenderCandidate[],
): Promise<Renderer | undefined> {
	if (rendererForTest)
		return { render: rendererForTest, close: async () => {} };
	const active = state as RenderState & {
		renderer?: ChromeRenderer;
		unavailableHinted?: boolean;
	};
	if (active.renderer) return active.renderer;
	if (state.summary.unavailableReason) return undefined;
	const binary = await findBrowserBinary();
	if (!binary) {
		markUnavailable(
			config,
			state,
			"no Chrome/Chromium/Edge binary found",
			"install Chrome/Chromium/Edge or set DOCSNAP_CHROME_PATH",
		);
		return undefined;
	}
	try {
		const session = await (browserLauncherForTest ?? launchBrowser)(binary);
		active.renderer = new ChromeRenderer(session, config);
		state.summary.browser = session.product;
		return active.renderer;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		const reason = `browser launch failed: ${message}`;
		state.launchFailures += browserLaunchFailureCount(error);
		if (state.launchFailures >= BROWSER_LAUNCH_FAILURE_LIMIT) {
			markUnavailable(
				config,
				state,
				browserLaunchUnavailableReason,
				"browser launch failed repeatedly",
			);
		}
		return failLaunch(candidates, state, reason);
	}
}

function markUnavailable(
	config: Config,
	state: RenderState & { progress?: Progress },
	reason: string,
	hint: string,
) {
	state.summary.unavailableReason = reason;
	const active = state as RenderState & { unavailableHinted?: boolean };
	if (!active.unavailableHinted && config.render === "auto") {
		state.progress?.(
			`docsnap: render unavailable; ${hint} (using static capture)`,
		);
		active.unavailableHinted = true;
	}
}

function failLaunch(
	candidates: RenderCandidate[],
	state: RenderState,
	message: string,
): undefined {
	for (const candidate of candidates) {
		state.summary.attempted++;
		state.summary.failedPages++;
		state.summary.pages.push({
			url: candidate.input.result.finalUrl,
			reason: candidate.reason,
			ok: false,
			renderMs: 0,
			resourceRequests: 0,
			blockedRequests: 0,
			error: `browser_crash: ${message}`,
		});
	}
	return undefined;
}

type Renderer = {
	render(candidate: RenderCandidate, config: Config): Promise<RenderPageOutput>;
	close(): Promise<void>;
};

function renderMetadata(
	reason: RenderReason,
	output: RenderPageOutput,
): PageRender {
	return {
		renderer: "chrome-cdp",
		reason,
		...(output.timedOut ? { timedOut: true } : {}),
		resourceRequests: output.resourceRequests,
		blockedRequests: output.blockedRequests,
		...(output.error ? { error: output.error } : {}),
	};
}

function renderLimit(config: Config) {
	return config.maxExplicit ? config.max : 50;
}
