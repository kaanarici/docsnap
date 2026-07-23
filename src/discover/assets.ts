import { parseHTML } from "linkedom";
import { awaitWithSignal, runBounded } from "../core/parallel.ts";
import {
	escapeRegExp,
	uniqueByWhitespace,
	whitespaceKey,
	wordCount,
} from "../core/text.ts";
import type {
	DiscoveredUrl,
	FetchResult,
	PipelineConfig,
} from "../core/types.ts";
import { balancedExpression } from "../extract/inline-state-scan.ts";
import { type FetchUrlGate, fetchText } from "../fetch/fetcher.ts";
import { candidateKey } from "./seed.ts";
import { normalizeUrl } from "./url.ts";

type AssetOptions = {
	limit: number;
	signal: AbortSignal;
	deadline: number;
	accept: (url: string) => boolean;
	required: (url: string) => number | undefined;
	requiredUnder: (url: string) => boolean;
	requiredCount: number;
	allowResource: FetchUrlGate;
};

type AssetRef = {
	url: string;
	prefixes: Set<string>;
	pageCandidate?: boolean;
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

type CompiledPage = {
	url: string;
	title: string;
	kind: "mdx" | "vue";
};
type AssetPages = { pages: DiscoveredUrl[]; truncated: boolean };

const graphAssetLimit = 32;
const maxAssetResponseBytes = 4 * 1024 * 1024;
const maxAssetBytes = 64 * 1024 * 1024;
const maxCompiledBlocks = 2_000;
const maxCompiledExpressionBytes = 256 * 1024;
const jsAccept = "application/javascript,text/javascript,*/*;q=0.8";

export async function discoverAssetPages(
	seed: string,
	html: string,
	config: PipelineConfig,
	options: AssetOptions,
): Promise<AssetPages> {
	if (options.limit <= 0) return { pages: [], truncated: false };

	const { assetRoot, routeRoot, language } = assetBases(seed, html);
	const assetOrigin = new URL(seed).origin;
	const allowAsset = (url: string) =>
		new URL(url).origin === assetOrigin && options.allowResource(url);
	const queue: AssetRef[] = [];
	const prefixesByAsset = new Map<string, Set<string>>();
	const fetched = new Set<string>();
	const pagesByAsset = new Map<string, CompiledPage[]>();
	const pageAssets = new Set<string>();
	const requiredAssets = new Set<string>();
	const requiredPages = new Map<number, DiscoveredUrl>();
	const otherPages = new Map<string, DiscoveredUrl>();
	let assetLimit = graphAssetLimit;
	let assetBytes = 0;
	let truncated = false;
	let complete = false;

	const addPage = (url: string, markdown: string) => {
		if (!options.accept(url)) return;
		const page: DiscoveredUrl = {
			url,
			source: "asset",
			fetched: syntheticFetch(url, markdown),
		};
		const required = options.required(url);
		if (required !== undefined) {
			requiredPages.set(required, page);
		} else if (otherPages.size < options.limit) {
			otherPages.set(candidateKey(url), page);
		}
	};
	const parseMappedPage = (url: string, body: string) => {
		for (const mapped of pagesByAsset.get(url) ?? []) {
			const markdown =
				mapped.kind === "mdx"
					? compiledMdxMarkdown(mapped.title, body, options.deadline)
					: compiledVueMarkdown(mapped.title, body, options.deadline);
			if (markdown) addPage(mapped.url, markdown);
		}
	};
	const finish = () => {
		if (
			requiredPages.size + otherPages.size < options.limit ||
			(config.pageOnly && requiredPages.size < options.requiredCount)
		)
			return false;
		complete = true;
		truncated ||= requiredPages.size < options.requiredCount;
		return true;
	};

	for (const url of scriptUrls(html, assetRoot)) {
		enqueueAsset(queue, prefixesByAsset, {
			url,
			prefixes: new Set([""]),
		});
	}

	while (fetched.size < assetLimit) {
		if (queue.length === 0) break;
		if (performance.now() >= options.deadline) {
			truncated = true;
			break;
		}
		const firstOther = queue.findIndex((item) => !requiredAssets.has(item.url));
		const batchSize = requiredAssets.has(queue[0]?.url ?? "")
			? Math.min(config.perOrigin, firstOther < 0 ? queue.length : firstOther)
			: config.perOrigin;
		const batch = nextAssets(
			queue,
			fetched,
			prefixesByAsset,
			batchSize,
			assetLimit,
		);
		if (batch.length === 0) break;
		const responses = await runBounded(
			batch,
			{
				concurrency: config.concurrency,
				perOrigin: config.perOrigin,
				key: (item) => new URL(item.url).origin,
			},
			async (item) => {
				const response = await awaitWithSignal(
					(async () =>
						!(await allowAsset(item.url))
							? undefined
							: await fetchText(
									item.url,
									config,
									jsAccept,
									undefined,
									allowAsset,
									{
										signal: options.signal,
										maxBytes: maxAssetResponseBytes,
									},
								))(),
					options.signal,
				).catch(() => undefined);
				return { item, response };
			},
		);

		for (const { item, response } of responses) {
			if (options.signal.aborted) {
				truncated = true;
				break;
			}
			if (!response?.ok) {
				if (response?.failureKind === "too_large") {
					truncated = true;
				}
				continue;
			}
			const bytes = Buffer.byteLength(response.body);
			if (bytes > maxAssetResponseBytes) {
				truncated = true;
				continue;
			}
			if (assetBytes + bytes > maxAssetBytes) {
				truncated = true;
				queue.length = 0;
				break;
			}
			assetBytes += bytes;
			parseMappedPage(item.url, response.body);
			for (const page of textPages(
				routeRoot,
				response.body,
				item.prefixes,
				options.deadline,
			)) {
				addPage(page.url, page.markdown);
			}
			if (finish()) break;
			const mappedAssets = [
				...viteMdxAssets(response.body, response.finalUrl, options).map(
					(mapped) => ({ ...mapped, kind: "mdx" as const }),
				),
				...viteVueAssets(
					response.body,
					response.finalUrl,
					language,
					options,
				).map((mapped) => ({ ...mapped, kind: "vue" as const })),
			];
			for (const mapped of mappedAssets.reverse()) {
				pageAssets.add(mapped.assetUrl);
				if (options.required(mapped.pageUrl) !== undefined) {
					requiredAssets.add(mapped.assetUrl);
				}
				const pages = pagesByAsset.get(mapped.assetUrl) ?? [];
				pages.push({
					url: mapped.pageUrl,
					title: mapped.title,
					kind: mapped.kind,
				});
				pagesByAsset.set(mapped.assetUrl, pages);
				enqueueAsset(
					queue,
					prefixesByAsset,
					{ url: mapped.assetUrl, prefixes: item.prefixes },
					true,
				);
			}
			const imports = importedAssets(
				response.body,
				response.finalUrl,
				item.prefixes,
				options.deadline,
			);
			for (const entry of imports) {
				if (entry.pageCandidate) pageAssets.add(entry.url);
				if (fetched.has(entry.url)) continue;
				const required =
					entry.pageCandidate &&
					[...entry.prefixes].some((path) =>
						options.requiredUnder(routeUrl(routeRoot, path)),
					);
				if (required) requiredAssets.add(entry.url);
				enqueueAsset(queue, prefixesByAsset, entry, Boolean(required));
			}
			assetLimit = Math.max(
				assetLimit,
				graphAssetLimit + Math.min(options.limit, pageAssets.size),
			);
			if (finish()) break;
		}
		if (complete) break;
	}

	const pages = [...requiredPages.values(), ...otherPages.values()].slice(
		0,
		options.limit,
	);
	if (
		!complete &&
		queue.length > 0 &&
		(requiredPages.size < options.requiredCount || pages.length < options.limit)
	)
		truncated = true;
	if (performance.now() >= options.deadline) truncated = true;
	return { pages, truncated };
}

function viteMdxAssets(js: string, base: string, options: AssetOptions) {
	const routeSet = new Set<string>();
	for (const match of js.matchAll(/\bpath:"(\/[^"?]*?)\/(?::(?:id|slug))"/g)) {
		if (performance.now() >= options.deadline) return [];
		routeSet.add(match[1]!);
	}
	if (routeSet.size === 0) return [];
	const routes = [...routeSet];
	const preferred: Array<{ assetUrl: string; pageUrl: string; title: string }> =
		[];
	const other: typeof preferred = [];
	const seen = new Set<string>();
	for (const match of js.matchAll(
		/case"([^"]+\.(?:md|mdx))":return[^;]{0,400}?import\("([^"]+\.m?js)"\)/g,
	)) {
		if (performance.now() >= options.deadline) return [];
		const page = viteMdxPage(match[1]!, routes, base);
		const assetUrl = normalizeUrl(match[2]!, base);
		if (
			!page ||
			!options.accept(page.pageUrl) ||
			!assetUrl ||
			new URL(assetUrl).origin !== new URL(base).origin
		)
			continue;
		if (seen.has(page.pageUrl)) continue;
		seen.add(page.pageUrl);
		const mapped = { assetUrl, ...page };
		if (options.required(page.pageUrl) !== undefined) preferred.push(mapped);
		else if (other.length < options.limit) other.push(mapped);
	}
	return [...preferred, ...other].slice(0, options.limit);
}

function viteMdxPage(source: string, routes: string[], base: string) {
	const match = source.match(
		/(?:^|\/)(?:langs\/([^/]+)\/)?([^/]+)\/([^/]+)\/(?:index|lesson)\.mdx?$/i,
	);
	if (!match || (match[1] && match[1] !== "en")) return undefined;
	const [, , category, id] = match;
	if (!category || !id) return undefined;
	const categoryKey = category.toLowerCase();
	const routesForCategory = routes.filter((route) => {
		const routeKey = route.split("/").filter(Boolean).at(-1)?.toLowerCase();
		return (
			routeKey && (categoryKey === routeKey || categoryKey === `${routeKey}s`)
		);
	});
	if (routesForCategory.length !== 1) return undefined;
	return {
		pageUrl: new URL(`${routesForCategory[0]}/${id}`, base).href,
		title: id
			.replace(/[-_]+/g, " ")
			.replace(/\b\w/g, (letter) => letter.toUpperCase()),
	};
}

function viteVueAssets(
	js: string,
	base: string,
	language: string,
	options: AssetOptions,
) {
	const loaders = new Map<string, Set<string>>();
	for (const match of js.matchAll(
		/\b([A-Za-z_$][\w$]*)=\(\)=>[^;]{0,160}?import\(("(?:\\[\s\S]|[^"\\])*\.m?js")\)/g,
	)) {
		if (performance.now() >= options.deadline) return [];
		const asset = normalizeUrl(decodeLiteral(match[2]!), base);
		if (asset && new URL(asset).origin === new URL(base).origin) {
			const assets = loaders.get(match[1]!) ?? new Set<string>();
			assets.add(asset);
			loaders.set(match[1]!, assets);
		}
	}
	if (loaders.size === 0) return [];

	type Candidate = {
		assetUrl: string;
		pageUrl: string;
		title: string;
		locale?: string;
		rank: number;
	};
	const candidates = new Map<string, Candidate>();
	for (const match of js.matchAll(
		/\bpath:("(?:\\[\s\S]|[^"\\])*")\s*,component:([A-Za-z_$][\w$]*)[^{}]{0,200}?meta:\{([^{}]{0,1000})\}/g,
	)) {
		if (performance.now() >= options.deadline) return [];
		const assets = loaders.get(match[2]!);
		const assetUrl = assets?.size === 1 ? [...assets][0] : undefined;
		const path = decodeLiteral(match[1]!);
		const titleLiteral = match[3]!.match(
			/\btitle:("(?:\\[\s\S]|[^"\\])*")/,
		)?.[1];
		const localeLiteral = match[3]!.match(
			/\blocale:("(?:\\[\s\S]|[^"\\])*")/,
		)?.[1];
		const pageUrl = path.startsWith("/") ? normalizeUrl(path, base) : undefined;
		const title = titleLiteral ? decodeLiteral(titleLiteral) : "";
		if (
			!assetUrl ||
			!pageUrl ||
			!title ||
			new URL(pageUrl).origin !== new URL(base).origin ||
			!options.accept(pageUrl)
		)
			continue;
		const locale = localeLiteral
			? decodeLiteral(localeLiteral).split(/[-_]/)[0]?.toLowerCase()
			: undefined;
		const rank =
			options.required(pageUrl) !== undefined
				? 0
				: locale === language
					? 1
					: locale
						? 3
						: 2;
		const existing = candidates.get(pageUrl);
		if (!existing || rank < existing.rank) {
			candidates.set(pageUrl, {
				assetUrl,
				pageUrl,
				title,
				rank,
				...(locale ? { locale } : {}),
			});
		}
	}
	const mapped = [...candidates.values()];
	const preferred = mapped.filter((candidate) => candidate.rank < 3);
	const fallbackLocale = mapped.find(
		(candidate) => candidate.rank === 3,
	)?.locale;
	return [
		...preferred,
		...(preferred.some((candidate) => candidate.rank > 0)
			? []
			: mapped.filter(
					(candidate) =>
						candidate.rank === 3 && candidate.locale === fallbackLocale,
				)),
	]
		.sort((left, right) => left.rank - right.rank)
		.slice(0, options.limit);
}

function compiledMdxMarkdown(title: string, js: string, deadline: number) {
	const titleKey = whitespaceKey(title);
	const { segments, total } = compiledSegments(js, deadline);
	if (total === 0 || segments.length / total < 0.75) return undefined;
	const unique = uniqueByWhitespace(segments).filter(
		(text) => whitespaceKey(text) !== titleKey,
	);
	if (wordCount(unique.join(" ")) < 30) return undefined;
	return [`# ${title}`, ...unique].join("\n\n").trim();
}

function compiledVueMarkdown(title: string, js: string, deadline: number) {
	const blocks: Array<{ index: number; text: string }> = [];
	let total = 0;
	let coveredUntil = 0;
	for (const match of js.matchAll(
		/\b[A-Za-z_$][\w$]*\("(p|li|pre|h[1-6])",(?:null|\{[^{}]{0,200}\}),/g,
	)) {
		if (performance.now() >= deadline) return undefined;
		if (match.index < coveredUntil) continue;
		total++;
		if (total > maxCompiledBlocks) return undefined;
		const expression = childExpression(js, match.index + match[0].length);
		if (!expression) continue;
		const tag = match[1]!;
		if (
			tag === "li" &&
			/\b[A-Za-z_$][\w$]*\("li",(?:null|\{[^{}]{0,200}\}),/.test(expression)
		)
			continue;
		const text = vueChildText(expression);
		if (!text) continue;
		if (tag === "li") {
			coveredUntil = match.index + match[0].length + expression.length;
		}
		blocks.push({
			index: match.index,
			text:
				tag === "pre"
					? `\`\`\`\n${text}\n\`\`\``
					: tag === "li"
						? `- ${text}`
						: tag.startsWith("h")
							? `${"#".repeat(Math.max(2, Number(tag[1])))} ${text}`
							: text,
		});
	}
	for (const match of js.matchAll(
		/\b[A-Za-z_$][\w$]*\([A-Za-z_$][\w$]*,\{[^{}]{0,200}?\blevel:"([1-6])"[^{}]*\},\{default:/g,
	)) {
		if (performance.now() >= deadline) return undefined;
		const expression = childExpression(js, match.index + match[0].length);
		const text = expression ? vueChildText(expression) : "";
		if (text) {
			blocks.push({
				index: match.index,
				text: `${"#".repeat(Math.max(2, Number(match[1])))} ${text}`,
			});
		}
	}
	const titleKey = whitespaceKey(title);
	const segments = uniqueByWhitespace(
		blocks
			.sort((left, right) => left.index - right.index)
			.map((block) => block.text),
	).filter((text) => whitespaceKey(text.replace(/^#+\s+/, "")) !== titleKey);
	if (segments.length / Math.max(1, total) < 0.5) return undefined;
	if (wordCount(segments.join(" ")) < 30) return undefined;
	return [`# ${title}`, ...segments].join("\n\n").trim();
}

function vueChildText(expression: string) {
	if (/^["'`]/.test(expression)) {
		return whitespaceKey(decodeLiteral(expression));
	}
	const literals: Array<{ index: number; text: string }> = [];
	for (const match of expression.matchAll(
		/\b[A-Za-z_$][\w$]*\(("(?:\\[\s\S]|[^"\\])*")(?:,-1)?\)/g,
	)) {
		literals.push({ index: match.index, text: decodeLiteral(match[1]!) });
	}
	for (const match of expression.matchAll(
		/\b[A-Za-z_$][\w$]*\("[A-Za-z][\w-]*",null,("(?:\\[\s\S]|[^"\\])*")(?:,-1)?\)/g,
	)) {
		literals.push({ index: match.index, text: decodeLiteral(match[1]!) });
	}
	return whitespaceKey(
		joinVueText(
			literals
				.sort((left, right) => left.index - right.index)
				.map((literal) => literal.text),
		),
	);
}

function compiledSegments(js: string, deadline: number) {
	const segments: string[] = [];
	let total = 0;
	for (const match of js.matchAll(
		/\b[A-Za-z_$][\w$]*\.(p|li|pre),\{children:/g,
	)) {
		if (performance.now() >= deadline) return { segments: [], total };
		total++;
		if (total > maxCompiledBlocks) return { segments: [], total };
		const expression = childExpression(js, match.index + match[0].length);
		if (!expression) continue;
		const text = compiledLiterals(expression)
			.filter(
				(value) =>
					!/^hljs(?:\b|-)|^language-|^xml$|^(?:\.{1,2}\/|https?:\/\/)/.test(
						value.trim().toLowerCase(),
					),
			)
			.join("")
			.trim();
		if (!text) continue;
		const tag = match[1];
		segments.push(
			tag === "pre"
				? `\`\`\`\n${text}\n\`\`\``
				: tag === "li"
					? `- ${whitespaceKey(text)}`
					: whitespaceKey(text),
		);
	}
	return { segments, total };
}

function joinVueText(parts: string[]) {
	return parts.reduce((text, part) => {
		if (!text || !part) return text || part;
		if (
			/\s$/.test(text) ||
			/^[\s,.;:!?)}\]]/.test(part) ||
			/[([{/]$/.test(text)
		) {
			return `${text}${part}`;
		}
		return `${text} ${part}`;
	}, "");
}

function childExpression(input: string, start: number) {
	const first = input[start];
	if (first === '"' || first === "'" || first === "`") {
		const match = input
			.slice(start, start + maxCompiledExpressionBytes)
			.match(
				/^(?:"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|`(?:\\[\s\S]|[^`\\])*`)/,
			);
		return match?.[0];
	}
	const opening = first === "[" ? start : input.indexOf("(", start);
	if (opening < 0 || opening - start > 80) return undefined;
	return balancedExpression(
		input,
		opening,
		opening + maxCompiledExpressionBytes,
	).value;
}

function compiledLiterals(input: string) {
	return [
		...input.matchAll(
			/"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|`(?:\\[\s\S]|[^`\\])*`/g,
		),
	]
		.map((match) => decodeLiteral(match[0]))
		.filter(Boolean);
}

export function assetSignature(seed: string, html: string) {
	const { assetRoot } = assetBases(seed, html);
	const urls = scriptUrls(html, assetRoot).sort();
	return urls.length ? urls.join("\n") : undefined;
}

function nextAssets(
	queue: AssetRef[],
	fetched: Set<string>,
	prefixesByAsset: Map<string, Set<string>>,
	concurrency: number,
	limit: number,
) {
	const batch: AssetRef[] = [];
	while (
		queue.length > 0 &&
		batch.length < concurrency &&
		fetched.size < limit
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
	front = false,
) {
	const existing = prefixesByAsset.get(asset.url);
	const prefixes = existing ?? new Set<string>();
	for (const prefix of asset.prefixes) prefixes.add(prefix);
	prefixesByAsset.set(asset.url, prefixes);
	if (!existing) front ? queue.unshift(asset) : queue.push(asset);
	else if (front) {
		const index = queue.findIndex((item) => item.url === asset.url);
		if (index > 0) queue.unshift(...queue.splice(index, 1));
	}
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
	deadline: number,
): AssetRef[] {
	const out: AssetRef[] = [];
	const routed = new Set<string>();
	for (const match of js.matchAll(
		/path:"([^"]+)",loadChildren:\(\)=>import\("([^"]+)"\)/g,
	)) {
		if (performance.now() >= deadline) break;
		const url = normalizeUrl(match[2]!, base);
		if (!url || new URL(url).origin !== new URL(base).origin) continue;
		routed.add(url);
		out.push({
			url,
			prefixes: new Set(
				[...prefixes].map((prefix) => joinRoute(prefix, match[1]!)),
			),
			pageCandidate: true,
		});
	}
	for (const match of js.matchAll(/\bimport\("([^"]+\.m?js)"\)/g)) {
		if (performance.now() >= deadline) break;
		const url = normalizeUrl(match[1]!, base);
		if (
			url &&
			!routed.has(url) &&
			new URL(url).origin === new URL(base).origin
		) {
			out.push({ url, prefixes });
		}
	}
	return out;
}

function textPages(
	base: string,
	js: string,
	prefixes: Set<string>,
	deadline: number,
): TextPage[] {
	const out: TextPage[] = [];
	for (const route of routeEntries(js, deadline)) {
		if (performance.now() >= deadline) break;
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

function routeEntries(js: string, deadline: number): RouteEntry[] {
	const routes: RouteEntry[] = [];
	for (const match of js.matchAll(
		/path:"([^"]+)",component:([A-Za-z_$][\w$]*),data:\{title:((?:"(?:\\[\s\S]|[^"\\])*"))/g,
	)) {
		if (performance.now() >= deadline) break;
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
	const segments = mergeTextSegments(
		uniqueByWhitespace(textCalls(block)).filter(
			(text) => whitespaceKey(text) !== titleKey && !assetNoiseText(text),
		),
	)
		.map(renderSegment)
		.filter(Boolean);
	if (segments.join("\n").length < 40) return undefined;
	return [`# ${title}`, ...segments].join("\n\n").trim();
}

function mergeTextSegments(parts: string[]): string[] {
	const out: string[] = [];
	let paragraph = "";
	const flush = () => {
		if (paragraph) out.push(paragraph);
		paragraph = "";
	};
	for (const part of parts.map((item) => item.trim()).filter(Boolean)) {
		if (part.includes("\n") || standaloneLabel(part)) {
			flush();
			out.push(part);
			continue;
		}
		if (!paragraph) {
			paragraph = part;
			continue;
		}
		if (
			/[.!?;:]$/.test(paragraph) &&
			/^[A-Z0-9]/.test(part) &&
			part.length > 30
		) {
			flush();
			paragraph = part;
			continue;
		}
		paragraph = joinVueText([paragraph, part]);
	}
	flush();
	return out;
}

function standaloneLabel(text: string) {
	return (
		text.length <= 60 &&
		!/[.!?;:]$/.test(text) &&
		/^(?:[A-Z][\w'’+-]*|\d+(?:\.\d+)*)(?:\s+[A-Z][\w'’+-]*){0,5}$/.test(text)
	);
}

function assetNoiseText(text: string) {
	return /^(?:figure|extension)$/i.test(whitespaceKey(text));
}

function textCalls(js: string): string[] {
	const out: string[] = [];
	for (const match of js.matchAll(
		/\b[$A-Za-z_][\w$]*\(\d+,((?:"(?:\\[\s\S]|[^"\\])*")|(?:`(?:\\[\s\S]|[^`\\])*`))/g,
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
			return JSON.parse(literal.replace(/\\\r?\n/g, "")) as string;
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

function assetBases(seed: string, html: string) {
	const { document } = parseHTML(html);
	const href = document.querySelector("base[href]")?.getAttribute("href");
	const normalizedBase = href ? normalizeUrl(href, seed) : undefined;
	const sameOriginBase =
		normalizedBase && new URL(normalizedBase).origin === new URL(seed).origin
			? normalizedBase
			: undefined;
	return {
		assetRoot: sameOriginBase ?? seed,
		routeRoot: sameOriginBase ?? new URL("/", seed).href,
		language:
			document.documentElement
				.getAttribute("lang")
				?.split(/[-_]/)[0]
				?.toLowerCase() ?? "en",
	};
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
