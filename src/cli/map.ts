import { pruneCache } from "../cache/eviction.ts";
import { buildPipelineConfig, type ConfigInput } from "../core/config.ts";
import { failureCanRetry } from "../core/types.ts";
import { discoverMap } from "../discover/map-run.ts";
import { failureResult, successResult, writeResult } from "./result.ts";

export async function runMap(input: ConfigInput, signal?: AbortSignal) {
	const built = buildPipelineConfig(input);
	const config = signal ? { ...built, signal } : built;
	let discovery: Awaited<ReturnType<typeof discoverMap>>;
	try {
		discovery = await discoverMap(config);
	} finally {
		await pruneCache(config);
	}
	const failures = discovery.urls.flatMap((entry) =>
		entry.fetched && !entry.fetched.ok
			? [
					{
						url: entry.url,
						failureKind: entry.fetched.failureKind,
						error: entry.fetched.error,
					},
				]
			: [],
	);
	const errors = failures.slice(0, 3);
	const entries = discovery.urls
		.filter((entry) => !entry.fetched || entry.fetched.ok)
		.map(({ url, source }) => ({ url, source }));
	const resultBase = {
		seedUrl: config.seedUrl,
		complete: discovery.complete ?? false,
		discoveryTruncated: discovery.truncated ?? false,
		limit: config.max,
		maxReached: entries.length >= config.max,
		entries,
		errors,
		errorsOmitted: failures.length - errors.length || undefined,
	};
	const result = discovery.render
		? { ...resultBase, render: discovery.render }
		: resultBase;
	const warnings = [
		...(failures.length
			? [
					`${failures.length} discovered URL${failures.length === 1 ? " failed" : "s failed"}.`,
				]
			: []),
		...(result.discoveryTruncated && !result.maxReached
			? ["Discovery stopped at its safety limit."]
			: []),
	];
	if (entries.length) {
		const message = `Found ${entries.length} capture candidate${entries.length === 1 ? "" : "s"}.`;
		const next = result.complete
			? "Capture the site when you are ready."
			: result.maxReached
				? "Use this map. Increase the page limit only if broader coverage matters."
				: "Use this map for the current task; capture a specific missing page only if it matters.";
		writeResult(successResult(result, message, next, warnings));
		return;
	}
	writeResult(
		failureResult({
			code: errors[0]?.failureKind?.toUpperCase() ?? "MAP_FAILED",
			message: errors[0]?.error ?? "DocSnap found no usable URLs.",
			next: "Check that the URL is public and reachable, then retry.",
			retryable: failureCanRetry(errors[0]?.failureKind),
			details: result,
		}),
	);
	process.exitCode = 1;
}
