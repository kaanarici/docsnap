import type { RunSummary } from "./types.ts";

export const autoFreshnessDays = 7;

const dayMs = 24 * 60 * 60 * 1000;
const autoFreshnessMs = autoFreshnessDays * dayMs;

export type FreshnessMode = "auto" | "reuse" | "refresh" | "force";
export type FreshnessDecision = "captured" | "refreshed" | "reused";

export function corpusIsStale(summary: RunSummary) {
	return corpusAgeMs(summary) >= autoFreshnessMs;
}

export function corpusAgeSeconds(summary: RunSummary) {
	return Math.round(corpusAgeMs(summary) / 1000);
}

export function corpusFreshness(
	mode: FreshnessMode,
	decision: FreshnessDecision,
	summary: RunSummary,
	prior: RunSummary | null,
) {
	const basis = prior ?? summary;
	return {
		requested_freshness: mode,
		decision,
		generated_at: summary.generatedAt,
		age_seconds: corpusAgeSeconds(summary),
		stale: corpusIsStale(basis),
		stale_after_days: autoFreshnessDays,
		...(prior && decision === "refreshed"
			? {
					prior_generated_at: prior.generatedAt,
					prior_age_seconds: corpusAgeSeconds(prior),
				}
			: {}),
	};
}

function corpusAgeMs(summary: RunSummary) {
	const generated = Date.parse(summary.generatedAt);
	if (!Number.isFinite(generated)) return 0;
	return Math.max(0, Date.now() - generated);
}
