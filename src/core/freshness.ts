import type { RunSummary } from "./types.ts";

const autoFreshnessDays = 7;

const dayMs = 24 * 60 * 60 * 1000;
const autoFreshnessMs = autoFreshnessDays * dayMs;

export type FreshnessMode = "auto" | "reuse" | "refresh" | "force";
export type FreshnessDecision = "captured" | "refreshed" | "reused";

type CorpusFreshness = {
	requestedFreshness: FreshnessMode;
	decision: FreshnessDecision;
	generatedAt: string;
	ageSeconds: number;
	stale: boolean;
	staleAfterDays: number;
	priorGeneratedAt?: string;
	priorAgeSeconds?: number;
};

export function corpusIsStale(summary: RunSummary) {
	return corpusAgeMs(summary) >= autoFreshnessMs;
}

function corpusAgeSeconds(summary: RunSummary) {
	return Math.round(corpusAgeMs(summary) / 1000);
}

export function corpusFreshness(
	mode: FreshnessMode,
	decision: FreshnessDecision,
	summary: RunSummary,
	prior: RunSummary | null,
) {
	const basis = prior ?? summary;
	const freshness: CorpusFreshness = {
		requestedFreshness: mode,
		decision,
		generatedAt: summary.generatedAt,
		ageSeconds: corpusAgeSeconds(summary),
		stale: corpusIsStale(basis),
		staleAfterDays: autoFreshnessDays,
	};
	if (prior && decision === "refreshed") {
		freshness.priorGeneratedAt = prior.generatedAt;
		freshness.priorAgeSeconds = corpusAgeSeconds(prior);
	}
	return freshness;
}

function corpusAgeMs(summary: RunSummary) {
	const generated = Date.parse(summary.generatedAt);
	if (!Number.isFinite(generated)) return 0;
	return Math.max(0, Date.now() - generated);
}
