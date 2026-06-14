import type {
	Config,
	FetchedUrl,
	PageRender,
	RenderReason,
	RenderSummary,
} from "../core/types.ts";

type Progress = (message: string) => void;
export const RENDER_MISS_REASON =
	"browser renderer removed; static plus inline-state capture only";
const renderMissError = `render_miss: ${RENDER_MISS_REASON}`;

export type RenderCandidate = {
	input: FetchedUrl;
	reason: RenderReason;
};

export type RenderAttempt = {
	input: FetchedUrl;
	reason: RenderReason;
	page: RenderSummary["pages"][number];
	render?: PageRender;
};

export type RenderState = {
	summary: RenderSummary;
};

export function createRenderState(
	config: Config,
	progress?: Progress,
): RenderState & { progress?: Progress } {
	return {
		summary: {
			mode: config.render,
			renderer: "none",
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

export async function closeRenderState(_state: RenderState): Promise<void> {}

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
	markUnavailable(state);
	const out = selected.map((candidate) => renderMiss(candidate, state));
	state.summary.elapsedMs = Number(
		(state.summary.elapsedMs + performance.now() - started).toFixed(1),
	);
	return out;
}

function markUnavailable(state: RenderState & { progress?: Progress }) {
	state.summary.unavailableReason = RENDER_MISS_REASON;
	const active = state as RenderState & { unavailableHinted?: boolean };
	if (!active.unavailableHinted) {
		state.progress?.(
			"docsnap: browser render unavailable; using static plus inline-state capture",
		);
		active.unavailableHinted = true;
	}
}

function renderMiss(
	candidate: RenderCandidate,
	state: RenderState,
): RenderAttempt {
	const page = {
		url: candidate.input.result.finalUrl,
		reason: candidate.reason,
		ok: false,
		renderMs: 0,
		resourceRequests: 0,
		blockedRequests: 0,
		error: renderMissError,
	};
	state.summary.attempted++;
	state.summary.failedPages++;
	state.summary.pages.push(page);
	return {
		input: candidate.input,
		reason: candidate.reason,
		page,
		render: renderMetadata(candidate.reason),
	};
}

function renderMetadata(reason: RenderReason): PageRender {
	return {
		renderer: "none",
		reason,
		resourceRequests: 0,
		blockedRequests: 0,
		error: renderMissError,
	};
}

function renderLimit(config: Config) {
	return config.maxExplicit ? config.max : 50;
}
