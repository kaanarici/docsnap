import { pruneCache } from "../cache/eviction.ts";
import { buildPipelineConfig } from "../core/config.ts";
import { terminalText } from "../core/text.ts";
import { discoverMap } from "../discover/map-run.ts";
import type { MapInput } from "./args.ts";

export async function runMap(input: MapInput) {
	const config = buildPipelineConfig(input.config);
	const started = performance.now();
	let discovery: Awaited<ReturnType<typeof discoverMap>>;
	try {
		discovery = await discoverMap(config);
	} finally {
		await pruneCache(config);
	}
	const errors = discovery.urls.flatMap((entry) =>
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
	const entries = discovery.urls
		.filter((entry) => !entry.fetched || entry.fetched.ok)
		.map(({ url, source }) => ({ url, source }));
	const resultBase = {
		ok: entries.length > 0,
		seedUrl: config.seedUrl,
		complete: discovery.complete ?? false,
		truncated: discovery.truncated ?? false,
		limit: config.max,
		maxReached: entries.length >= config.max,
		entries,
		errors,
		elapsedMs: Number((performance.now() - started).toFixed(1)),
	};
	const result = discovery.render
		? { ...resultBase, render: discovery.render }
		: resultBase;
	if (input.json) process.stdout.write(`${JSON.stringify(result)}\n`);
	else if (entries.length)
		process.stdout.write(
			terminalText(`${entries.map((entry) => entry.url).join("\n")}\n`),
		);
	else
		process.stderr.write(
			terminalText(`${errors[0]?.error ?? "No URLs discovered"}\n`),
		);
	if (!result.ok) process.exitCode = 1;
}
