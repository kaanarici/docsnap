import { validatePublicHttpUrl } from "../security/url.ts";
import { InputError } from "./input-error.ts";
import type { PipelineConfig, RunSummary } from "./types.ts";
import { canonicalUrlSearch, looksLikeSpecificContentUrl } from "./url.ts";

const defaultConcurrency = 16;
const defaultPerOrigin = 8;
const maxUserAgentChars = 1024;
const maxPathPatterns = 32;
const maxPathPatternChars = 512;
const defaultUserAgent =
	"Mozilla/5.0 (compatible; docsnap; +https://npmjs.com/package/docsnap)";
export const maxGeneratedCapturePages = 2_000;
const maxPathSlugLength = 96;

export type ConfigInput = {
	seedUrl: string;
	outDir?: string;
	max?: number;
	maxExplicit?: boolean;
	concurrency?: number;
	clean?: boolean;
	pageOnly?: boolean;
	site?: boolean;
	cache?: boolean;
	include?: string[];
	exclude?: string[];
	userAgent?: string;
	timeoutMs?: number;
	maxBytes?: number;
};

export function buildPipelineConfig(input: ConfigInput): PipelineConfig {
	let seedUrl: string;
	try {
		seedUrl = parseUrl(input.seedUrl).href;
	} catch {
		throw new InputError(`Invalid URL: ${input.seedUrl}`);
	}
	const unsafe = validatePublicHttpUrl(seedUrl);
	if (unsafe) throw new InputError(`Unsafe URL: ${unsafe}`);

	const max = positiveInteger(
		input.max ?? 50,
		"--max",
		maxGeneratedCapturePages,
	);
	const concurrency = positiveInteger(
		input.concurrency ?? defaultConcurrency,
		"--concurrency",
	);
	const timeoutMs = positiveInteger(input.timeoutMs ?? 10_000, "timeoutMs");
	const maxBytes = positiveInteger(
		input.maxBytes ?? 12 * 1024 * 1024,
		"maxBytes",
	);
	const include = pathPatterns(input.include ?? [], "--include");
	const exclude = pathPatterns(input.exclude ?? [], "--exclude");

	const userAgent = input.userAgent ?? defaultUserAgent;
	if (
		userAgent.length < 1 ||
		userAgent.length > maxUserAgentChars ||
		/[^\x20-\x7e\x80-\xff]/.test(userAgent)
	) {
		throw new InputError(
			`--user-agent must be 1 to ${maxUserAgentChars} printable characters`,
		);
	}

	const config: PipelineConfig = {
		seedUrl,
		outDir: input.outDir ?? defaultOutDir(seedUrl),
		max,
		maxExplicit: input.maxExplicit ?? input.max !== undefined,
		concurrency,
		perOrigin: Math.min(concurrency, defaultPerOrigin),
		clean: input.clean ?? false,
		pageOnly: autoPageOnly(seedUrl, input),
		cache: input.cache ?? true,
		include,
		exclude,
		userAgent,
		timeoutMs,
		maxBytes,
	};
	return config;
}

export function buildRefreshConfig(
	prior: Pick<
		RunSummary,
		| "seedUrl"
		| "max"
		| "maxAppliesTo"
		| "captureMode"
		| "userAgent"
		| "include"
		| "exclude"
	>,
	input: {
		outDir: string;
		max: number | undefined;
		concurrency?: number | undefined;
		cache: boolean;
	},
): PipelineConfig {
	const config: ConfigInput = {
		seedUrl: prior.seedUrl,
		outDir: input.outDir,
		max: input.max ?? prior.max,
		maxExplicit: input.max !== undefined || prior.maxAppliesTo === "all",
		pageOnly: prior.captureMode === "page",
		userAgent: prior.userAgent,
		include: prior.include ?? [],
		exclude: prior.exclude ?? [],
		cache: input.cache,
	};
	if (input.concurrency !== undefined) config.concurrency = input.concurrency;
	return buildPipelineConfig(config);
}

function positiveInteger(
	value: number,
	name: string,
	max = Number.MAX_SAFE_INTEGER,
) {
	if (!Number.isSafeInteger(value) || value < 1)
		throw new InputError(`${name} must be a positive integer`);
	if (value > max) throw new InputError(`${name} must be ${max} or fewer`);
	return value;
}

function pathPatterns(values: string[], flag: string) {
	if (values.length > maxPathPatterns)
		throw new InputError(
			`${flag} may be repeated ${maxPathPatterns} times or fewer`,
		);
	const patterns = new Set<string>();
	for (const value of values) {
		if (
			!value.startsWith("/") ||
			value.length > maxPathPatternChars ||
			value.includes("?") ||
			value.includes("#") ||
			[...value].some((character) => {
				const code = character.charCodeAt(0);
				return code < 32 || code === 127;
			})
		) {
			throw new InputError(`${flag} requires a URL path glob such as /docs/**`);
		}
		try {
			new Bun.Glob(value);
		} catch {
			throw new InputError(`Invalid ${flag} glob: ${value}`);
		}
		patterns.add(value);
	}
	return [...patterns];
}

export function discoveryAttemptLimit(config: PipelineConfig) {
	return config.maxExplicit &&
		!config.pageOnly &&
		config.max < maxGeneratedCapturePages
		? Math.min(maxGeneratedCapturePages, config.max * 2)
		: config.max;
}

function defaultOutDir(seedUrl: string) {
	const url = new URL(seedUrl);
	const host = slug(url.hostname.replace(/^www\./, ""));
	const path = pathSlug(url.pathname);
	const name = [host, path, querySlug(url)].filter(Boolean).join("-");
	return `docsnap/${name || "site"}`;
}

function pathSlug(pathname: string) {
	const label = pathname.split("/").filter(Boolean).map(slug).filter(Boolean);
	const joined = label.join("-");
	if (joined.length <= maxPathSlugLength) return joined;
	return `${joined.slice(0, maxPathSlugLength - 9).replace(/-+$/g, "")}-${shortHash(pathname)}`;
}

function autoPageOnly(seedUrl: string, input: ConfigInput) {
	if (input.pageOnly === true) return true;
	if (
		input.site === true ||
		input.max !== undefined ||
		input.maxExplicit ||
		input.include?.length ||
		input.exclude?.length
	) {
		return false;
	}
	return looksLikeSpecificContentUrl(seedUrl);
}

function querySlug(url: URL) {
	const query = canonicalUrlSearch(url);
	if (!query) return "";
	const label = slug(query.slice(1)).slice(0, 48).replace(/-+$/g, "");
	return `q-${label || "params"}-${shortHash(query)}`;
}

function shortHash(value: string) {
	return Bun.CryptoHasher.hash("sha256", value, "hex").slice(0, 8);
}

function slug(value: string) {
	return value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
}

function parseUrl(value: string) {
	if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return new URL(value);
	return new URL(`https://${value}`);
}
