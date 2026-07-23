import { createHash } from "node:crypto";
import { cpus } from "node:os";
import { validatePublicHttpUrl } from "../security/url.ts";
import type { PipelineConfig } from "./types.ts";
import { canonicalUrlSearch, looksLikeSpecificContentUrl } from "./url.ts";

const cpuCount = cpus().length;
const defaultConcurrency = Math.min(64, Math.max(16, cpuCount * 6));
const defaultPerOrigin = Math.min(defaultConcurrency, 8);
export const defaultUserAgent =
	"Mozilla/5.0 (compatible; docsnap; +https://npmjs.com/package/docsnap)";
export const maxGeneratedCapturePages = 500;
const maxPathSlugLength = 96;

export type ConfigInput = {
	seedUrl: string;
	outDir?: string;
	max?: number;
	maxExplicit?: boolean;
	concurrency?: number;
	clean?: boolean;
	dryRun?: boolean;
	pageOnly?: boolean;
	site?: boolean;
	cache?: boolean;
	userAgent?: string;
	timeoutMs?: number;
	maxBytes?: number;
	topic?: string;
};

export function buildPipelineConfig(input: ConfigInput): PipelineConfig {
	let seedUrl: string;
	try {
		seedUrl = parseUrl(input.seedUrl).href;
	} catch {
		throw new Error(`Invalid URL: ${input.seedUrl}`);
	}
	const unsafe = validatePublicHttpUrl(seedUrl);
	if (unsafe) throw new Error(`Unsafe URL: ${unsafe}`);

	const max = input.max ?? 50;
	if (max < 1) throw new Error("--max must be at least 1");
	const concurrency = input.concurrency ?? defaultConcurrency;
	if (concurrency < 1) throw new Error("--concurrency must be at least 1");
	const timeoutMs = input.timeoutMs ?? 10_000;
	if (timeoutMs < 1) throw new Error("timeoutMs must be at least 1");
	const maxBytes = input.maxBytes ?? 12 * 1024 * 1024;
	if (maxBytes < 1) throw new Error("maxBytes must be at least 1");

	return {
		seedUrl,
		outDir: input.outDir ?? defaultOutDir(seedUrl),
		max,
		maxExplicit: input.maxExplicit ?? input.max !== undefined,
		concurrency,
		perOrigin: Math.min(concurrency, defaultPerOrigin),
		clean: input.clean ?? false,
		dryRun: input.dryRun ?? false,
		pageOnly: autoPageOnly(seedUrl, input),
		cache: input.dryRun ? false : (input.cache ?? true),
		userAgent: input.userAgent ?? defaultUserAgent,
		timeoutMs,
		maxBytes,
		...(input.topic?.trim() ? { topic: input.topic.trim() } : {}),
	};
}

export function captureSelectionTerms(topic?: string) {
	return [
		...new Set(
			(topic ?? "")
				.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
				.toLowerCase()
				.split(/[^a-z0-9]+/)
				.filter((term) => term.length > 2)
				.map(normalizeSelectionTerm),
		),
	];
}

export function captureSelectionHash(topic?: string) {
	const terms = captureSelectionTerms(topic);
	return terms.length
		? createHash("sha256")
				.update(`topic-v2\0${terms.join("\0")}`)
				.digest("hex")
		: undefined;
}

function normalizeSelectionTerm(term: string) {
	if (term.length > 4 && term.endsWith("ies")) return `${term.slice(0, -3)}y`;
	if (term.length > 4 && term.endsWith("sses")) return term.slice(0, -2);
	if (
		term.length > 3 &&
		term.endsWith("s") &&
		!term.endsWith("ss") &&
		!term.endsWith("is") &&
		!term.endsWith("us")
	)
		return term.slice(0, -1);
	return term;
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
	if (input.site === true || input.max !== undefined || input.maxExplicit) {
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
	return createHash("sha256").update(value).digest("hex").slice(0, 8);
}

function slug(value: string) {
	return value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
}

function parseUrl(value: string) {
	if (/^https?:\/\//i.test(value)) return new URL(value);
	return new URL(`https://${value}`);
}
