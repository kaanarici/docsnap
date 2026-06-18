import type { ConfigInput } from "../cli/args.ts";
import { runPipeline } from "../core/pipeline.ts";
import type { PipelineConfig, RunSummary } from "../core/types.ts";
import { runFiles } from "../output/files.ts";
import {
	type McpState,
	readableCorpusDir,
	rememberCorpus,
	writableCorpusDir,
} from "./access.ts";
import { buildContextPack } from "./context-pack.ts";
import { listPages, readSummary } from "./corpus.ts";
import type { FetchToolInput } from "./inputs.ts";

// docsnap_fetch is the drop-in WebFetch replacement: one call that captures (or
// reuses/refreshes) a public URL into a persistent corpus, then returns the best
// cited context for a question. It is a thin orchestration over runPipeline,
// readSummary, and the ranked context-pack path; it duplicates no capture or
// ranking logic. MCP-mode safety is inherited from the caller-supplied config
// (buildPipelineConfig defaults ignoreRobots:false) and from the context-pack /
// frameWebContent fencing.

export type FetchToolDeps = {
	// builds an MCP capture PipelineConfig (ignoreRobots:false by default) from a
	// typed ConfigInput; supplied by tools.ts so fetch reuses the exact same
	// safety contract and invariants as docsnap_capture.
	buildConfig: (input: ConfigInput) => PipelineConfig;
	progress: (message: string) => void;
};

export type FetchScope = "page" | "site";
type FetchAction = "captured" | "refreshed" | "reused";

const topPagesLimit = 10;
const autoSiteCap = 25;
const defaultSnippets = 8;

export async function runFetchTool(
	input: FetchToolInput,
	deps: FetchToolDeps,
	state: McpState,
) {
	const scope = resolveScope(input);
	const base = buildBaseConfig(input, scope, deps);
	const outputDir = await writableCorpusDir(input.output_dir ?? base.outDir);
	const existing = await existingCorpus(outputDir, state);
	const action = decideAction(input.freshness, existing !== null);

	const summary =
		action === "reused" && existing
			? existing
			: await capture(input, base, outputDir, action, deps);
	rememberCorpus(state, summary.outDir);

	const corpus = corpusInfo(summary, action, scope);
	if (input.question) {
		const pack = await buildContextPack(summary.outDir, {
			query: input.question,
			maxSnippets: defaultSnippets,
			contextChars: input.context_chars,
			excludeInjection: input.safety === "exclude_injection",
		});
		return { corpus, question: input.question, ...pack };
	}
	return {
		corpus,
		top_pages: await topPages(summary.outDir),
		next_actions: [
			"Call docsnap_fetch again with a question to get a ranked, cited context pack.",
			"Or run docsnap_search_corpus / docsnap_context_pack on this output_dir.",
		],
	};
}

async function capture(
	input: FetchToolInput,
	base: PipelineConfig,
	outputDir: string,
	action: FetchAction,
	deps: FetchToolDeps,
): Promise<RunSummary> {
	const config: PipelineConfig = { ...base, outDir: outputDir };
	// "force" recaptures from scratch; "refresh" lets prior pages reuse via
	// ETag/Last-Modified because loadPrior reads the existing manifest in place.
	if (action === "captured" && input.freshness === "force") config.clean = true;
	const result = await runPipeline(config, deps.progress);
	return result.summary;
}

// reuse skips the network when a corpus exists; refresh re-runs the seed and
// reuses unchanged pages; force recaptures. A missing corpus always captures.
function decideAction(
	freshness: FetchToolInput["freshness"],
	hasCorpus: boolean,
): FetchAction {
	if (!hasCorpus) return "captured";
	if (freshness === "reuse") return "reused";
	if (freshness === "refresh") return "refreshed";
	return "captured";
}

async function existingCorpus(
	outputDir: string,
	state: McpState,
): Promise<RunSummary | null> {
	try {
		const dir = await readableCorpusDir(outputDir, state.corpora);
		return await readSummary(dir);
	} catch {
		return null;
	}
}

function buildBaseConfig(
	input: FetchToolInput,
	scope: FetchScope,
	deps: FetchToolDeps,
): PipelineConfig {
	const max = captureMax(input, scope);
	return deps.buildConfig({
		seedUrl: input.url,
		pageOnly: scope === "page",
		...(max !== undefined ? { max } : {}),
		maxExplicit: true,
	});
}

// page: a single page; explicit max_pages wins; an auto-resolved site stays
// capped small to keep one-call fetch fast and polite, while an explicit
// scope:"site" keeps the full default budget.
function captureMax(
	input: FetchToolInput,
	scope: FetchScope,
): number | undefined {
	if (scope === "page") return 1;
	if (input.max_pages !== undefined) return input.max_pages;
	if (input.scope === "auto" || input.scope === undefined) return autoSiteCap;
	return undefined;
}

// auto: a URL that points at a specific document (file-like last segment or a
// deep path) is captured as a single page; a shallow root/section URL gets a
// small site capture. scope "page"/"site" override the heuristic.
function resolveScope(input: FetchToolInput): FetchScope {
	if (input.scope === "page") return "page";
	if (input.scope === "site") return "site";
	return looksLikeSpecificDoc(input.url) ? "page" : "site";
}

function looksLikeSpecificDoc(rawUrl: string): boolean {
	let url: URL;
	try {
		url = new URL(rawUrl);
	} catch {
		return false;
	}
	const segments = url.pathname.split("/").filter(Boolean);
	if (segments.length === 0) return false;
	const last = segments[segments.length - 1] ?? "";
	if (/\.(?:html?|mdx?|txt|json|rst)$/i.test(last)) return true;
	return segments.length >= 3;
}

function corpusInfo(
	summary: RunSummary,
	action: FetchAction,
	scope: FetchScope,
) {
	return {
		action,
		scope,
		output_dir: summary.outDir,
		seed_url: summary.seedUrl,
		status: summary.status,
		written: summary.written,
		failed: summary.failed,
		injection_signal_pages: summary.injectionSignalPages,
		paths: {
			summary: `${summary.outDir}/${runFiles.summary}`,
			manifest: `${summary.outDir}/${runFiles.manifest}`,
			agent_readme: `${summary.outDir}/${runFiles.agentReadme}`,
		},
	};
}

async function topPages(outputDir: string) {
	try {
		const listed = await listPages(outputDir, topPagesLimit, undefined, false);
		return listed.pages.map((page) => ({
			output_path: page.output_path,
			url: page.url,
			...(page.untrusted_web_title
				? { untrusted_web_title: page.untrusted_web_title }
				: {}),
		}));
	} catch {
		return [];
	}
}
