import { parseHTML } from "linkedom";
import {
	escapeRegExp,
	uniqueByWhitespace,
	whitespaceKey,
} from "../core/text.ts";
import type { Config, DiscoveredUrl, FetchResult } from "../core/types.ts";
import { looksLikeAppShell } from "../extract/app-shell.ts";
import { type FetchUrlGate, fetchText } from "../fetch/fetcher.ts";
import { runBounded } from "../fetch/rate-limit.ts";
import { inScope, normalizeUrl } from "./url.ts";

type AssetOptions = {
	limit: number;
	scope: string;
	accept: (url: string) => boolean;
	allowResource?: FetchUrlGate | undefined;
};

type AssetRef = {
	url: string;
	prefixes: Set<string>;
};

type TextAsset = {
	url: string;
	body: string;
	prefixes: Set<string>;
};

type RouteEntry = {
	path: string;
	title: string;
	componentId: string;
};

type TextPage = {
	url: string;
	markdown: string;
};

const maxAssets = 32;
const jsAccept = "application/javascript,text/javascript,*/*;q=0.8";

export async function discoverAssetPages(
	seed: string,
	html: string,
	config: Config,
	options: AssetOptions,
): Promise<DiscoveredUrl[]> {
	if (options.limit <= 0 || !looksLikeAppShell(html)) return [];

	const assetRoot = assetBase(seed, html);
	const queue: AssetRef[] = [];
	const prefixesByAsset = new Map<string, Set<string>>();
	const assets: TextAsset[] = [];
	const fetched = new Set<string>();

	for (const url of scriptUrls(html, assetRoot)) {
		enqueueAsset(queue, prefixesByAsset, {
			url,
			prefixes: new Set([""]),
		});
	}

	while (fetched.size < maxAssets) {
		const batch = nextAssets(
			queue,
			fetched,
			prefixesByAsset,
			config.concurrency,
		);
		if (batch.length === 0) break;
		const responses = await runBounded(
			batch,
			{
				concurrency: config.concurrency,
				perOrigin: config.perOrigin,
				key: (item) => new URL(item.url).origin,
			},
			async (item) => ({
				item,
				response:
					options.allowResource && !(await options.allowResource(item.url))
						? undefined
						: await fetchText(
								item.url,
								config,
								jsAccept,
								undefined,
								options.allowResource,
							),
			}),
		);

		for (const { item, response } of responses) {
			if (!response?.ok) continue;
			if (
				options.allowResource &&
				response.finalUrl !== item.url &&
				!(await options.allowResource(response.finalUrl))
			)
				continue;
			assets.push({
				url: response.finalUrl,
				body: response.body,
				prefixes: item.prefixes,
			});
			for (const entry of importedAssets(
				response.body,
				response.finalUrl,
				item.prefixes,
			)) {
				if (fetched.has(entry.url)) continue;
				enqueueAsset(queue, prefixesByAsset, entry);
			}
		}
	}

	const pages = new Map<string, DiscoveredUrl>();
	for (const asset of assets) {
		for (const page of textPages(seed, asset.body, asset.prefixes)) {
			if (pages.size >= options.limit) break;
			if (!inScope(page.url, seed, options.scope) || !options.accept(page.url))
				continue;
			pages.set(page.url, {
				url: page.url,
				source: "asset",
				fetched: syntheticFetch(page.url, page.markdown),
			});
		}
		if (pages.size >= options.limit) break;
	}
	return [...pages.values()];
}

function nextAssets(
	queue: AssetRef[],
	fetched: Set<string>,
	prefixesByAsset: Map<string, Set<string>>,
	concurrency: number,
) {
	const batch: AssetRef[] = [];
	while (
		queue.length > 0 &&
		batch.length < concurrency &&
		fetched.size < maxAssets
	) {
		const item = queue.shift()!;
		if (fetched.has(item.url)) continue;
		fetched.add(item.url);
		batch.push({
			url: item.url,
			prefixes: prefixesByAsset.get(item.url) ?? item.prefixes,
		});
	}
	return batch;
}

function enqueueAsset(
	queue: AssetRef[],
	prefixesByAsset: Map<string, Set<string>>,
	asset: AssetRef,
) {
	const existing = prefixesByAsset.get(asset.url);
	const prefixes = existing ?? new Set<string>();
	for (const prefix of asset.prefixes) prefixes.add(prefix);
	prefixesByAsset.set(asset.url, prefixes);
	if (!existing) queue.push(asset);
}

function scriptUrls(html: string, base: string): string[] {
	const origin = new URL(base).origin;
	const { document } = parseHTML(html);
	const urls = new Set<string>();
	for (const element of document.querySelectorAll("script[src],link[href]")) {
		const raw =
			element.getAttribute("src") ?? element.getAttribute("href") ?? "";
		if (!/\.m?js(?:$|\?)/i.test(raw)) continue;
		const url = normalizeUrl(raw, base);
		if (url && new URL(url).origin === origin) urls.add(url);
	}
	return [...urls];
}

function importedAssets(
	js: string,
	base: string,
	prefixes: Set<string>,
): AssetRef[] {
	const out: AssetRef[] = [];
	for (const match of js.matchAll(
		/path:"([^"]+)",loadChildren:\(\)=>import\("([^"]+)"\)/g,
	)) {
		const url = normalizeUrl(match[2]!, base);
		if (!url || new URL(url).origin !== new URL(base).origin) continue;
		out.push({
			url,
			prefixes: new Set(
				[...prefixes].map((prefix) => joinRoute(prefix, match[1]!)),
			),
		});
	}
	for (const match of js.matchAll(/\bimport\("([^"]+\.m?js)"\)/g)) {
		const url = normalizeUrl(match[1]!, base);
		if (url && new URL(url).origin === new URL(base).origin) {
			out.push({ url, prefixes });
		}
	}
	return out;
}

function textPages(
	base: string,
	js: string,
	prefixes: Set<string>,
): TextPage[] {
	const out: TextPage[] = [];
	for (const route of routeEntries(js)) {
		const block = textBlock(js, route.componentId);
		if (!block) continue;
		const markdown = pageMarkdown(route.title, block);
		if (!markdown) continue;
		for (const prefix of prefixes) {
			out.push({
				url: routeUrl(base, joinRoute(prefix, route.path)),
				markdown,
			});
		}
	}
	return out;
}

function routeEntries(js: string): RouteEntry[] {
	const routes: RouteEntry[] = [];
	for (const match of js.matchAll(
		/path:"([^"]+)",component:([A-Za-z_$][\w$]*),data:\{title:((?:"(?:\\.|[^"\\])*"))/g,
	)) {
		const path = match[1]!;
		const componentId = match[2]!;
		const title = decodeLiteral(match[3]!);
		if (path && componentId && title) routes.push({ path, title, componentId });
	}
	return routes;
}

function textBlock(js: string, id: string): string | undefined {
	const start = js.search(
		new RegExp(`(?:var|let|const)\\s+${escapeRegExp(id)}\\s*=`),
	);
	if (start < 0) return undefined;
	const rest = js.slice(start);
	const next = rest.search(/\}\)\(\);(?:var|let|const)\s/);
	return js.slice(start, next >= 0 ? start + next : js.length);
}

function pageMarkdown(title: string, block: string): string | undefined {
	const titleKey = whitespaceKey(title);
	const segments = uniqueByWhitespace(textCalls(block))
		.filter((text) => whitespaceKey(text) !== titleKey)
		.map(renderSegment)
		.filter(Boolean);
	if (segments.join("\n").length < 40) return undefined;
	return [`# ${title}`, ...segments].join("\n\n").trim();
}

function textCalls(js: string): string[] {
	const out: string[] = [];
	for (const match of js.matchAll(
		/\b[$A-Za-z_][\w$]*\(\d+,((?:"(?:\\.|[^"\\])*")|(?:`(?:\\.|[^`\\])*`))/g,
	)) {
		const text = decodeLiteral(match[1]!).trim();
		if (isReadableText(text)) out.push(text);
	}
	return out;
}

function isReadableText(text: string): boolean {
	if (!text || text.length > 8_000) return false;
	if (/^[a-z][\w-]*$/i.test(text) && htmlWords.has(text.toLowerCase()))
		return false;
	if (/^(app-|router-|ng-)/.test(text)) return false;
	return /[A-Za-z0-9]/.test(text);
}

function renderSegment(text: string): string {
	const trimmed = text.trim();
	if (!trimmed) return "";
	if (trimmed.includes("\n")) return `\`\`\`\n${trimmed}\n\`\`\``;
	return whitespaceKey(trimmed);
}

function decodeLiteral(literal: string): string {
	if (literal.startsWith('"')) {
		try {
			return JSON.parse(literal) as string;
		} catch {
			return "";
		}
	}
	return literal
		.slice(1, -1)
		.replace(/\$\{[^}]*}/g, "")
		.replace(/\\`/g, "`")
		.replace(/\\n/g, "\n")
		.replace(/\\r/g, "\r")
		.replace(/\\t/g, "\t")
		.replace(/\\\\/g, "\\");
}

function assetBase(seed: string, html: string): string {
	const { document } = parseHTML(html);
	const href = document.querySelector("base[href]")?.getAttribute("href");
	return normalizeUrl(href ?? seed, seed) ?? seed;
}

function routeUrl(base: string, path: string): string {
	return new URL(path, base.endsWith("/") ? base : `${base}/`).href;
}

function joinRoute(prefix: string, path: string): string {
	return [prefix, path]
		.flatMap((part) => part.split("/"))
		.filter(Boolean)
		.join("/");
}

function syntheticFetch(url: string, body: string): FetchResult {
	return {
		url,
		finalUrl: url,
		status: 200,
		contentType: "text/markdown",
		body,
		ok: true,
		fetchMs: 0,
		redirects: [],
	};
}

const htmlWords = new Set([
	"a",
	"article",
	"blockquote",
	"button",
	"code",
	"col",
	"colgroup",
	"div",
	"footer",
	"h1",
	"h2",
	"h3",
	"h4",
	"header",
	"i",
	"img",
	"li",
	"main",
	"nav",
	"p",
	"pre",
	"section",
	"span",
	"strong",
	"table",
	"tbody",
	"td",
	"tfoot",
	"th",
	"thead",
	"tr",
	"ul",
]);
