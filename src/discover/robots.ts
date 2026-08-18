import { awaitWithSignal } from "../core/parallel.ts";
import type { PipelineConfig } from "../core/types.ts";
import { fetchTextUncached } from "../fetch/fetcher.ts";

// Bound hostile robots files independently from normal page bodies. The
// renderer also charges this cap against its aggregate relay budget.
export const maxRobotsBytes = 512 * 1024;
const MAX_ROBOTS_LINES = 100_000;
const MAX_AGENTS_PER_GROUP = 1_000;
const MAX_RULES = 5_000;
const MAX_SITEMAPS = 10_000;
const textEncoder = new TextEncoder();
const robotsByConfig = new WeakMap<
	PipelineConfig,
	Map<string, Promise<Robots>>
>();

export type Robots = {
	sitemaps: string[];
	allows: Rule[];
	disallows: Rule[];
	allowed: (url: string) => boolean;
};

type Rule = {
	specificity: number;
	matches: (path: string) => boolean;
};

export function loadRobots(
	origin: string,
	config: PipelineConfig,
	signal?: AbortSignal,
): Promise<Robots> {
	let byOrigin = robotsByConfig.get(config);
	if (!byOrigin) {
		byOrigin = new Map();
		robotsByConfig.set(config, byOrigin);
	}
	const existing = byOrigin.get(origin);
	if (existing) return awaitWithSignal(existing, signal);
	const pending = fetchRobots(origin, config, signal).catch((error) => {
		byOrigin.delete(origin);
		throw error;
	});
	byOrigin.set(origin, pending);
	return pending;
}

async function fetchRobots(
	origin: string,
	config: PipelineConfig,
	signal?: AbortSignal,
): Promise<Robots> {
	const options = signal
		? { signal, maxBytes: maxRobotsBytes }
		: { maxBytes: maxRobotsBytes };
	const response = await fetchTextUncached(
		`${origin}/robots.txt`,
		config,
		"text/plain,*/*;q=0.8",
		undefined,
		undefined,
		options,
	);
	signal?.throwIfAborted();
	return robotsFromFetch(response, origin, config.userAgent);
}

export function robotsFromFetch(
	response: { ok: boolean; status: number; body: string },
	origin: string,
	userAgent = "docsnap",
): Robots {
	if (!response.ok) {
		if (response.status >= 400 && response.status < 500) return openRobots();
		return closedRobots();
	}
	return parseRobots(response.body, origin, userAgent);
}

export function parseRobots(
	body: string,
	origin: string,
	userAgent = "docsnap",
): Robots {
	const sitemaps: string[] = [];
	const groups: RobotsGroup[] = [];
	let group = newGroup();
	let rules = 0;
	let truncated = false;

	for (const raw of robotsLines(body)) {
		if (raw === undefined) {
			truncated = true;
			break;
		}
		const line = raw.replace(/#.*/, "").trim();
		if (!line) continue;
		const [fieldRaw, ...rest] = line.split(":");
		const field = fieldRaw?.trim().toLowerCase();
		const value = rest.join(":").trim();
		if (field === "sitemap" && value) {
			if (sitemaps.length >= MAX_SITEMAPS) continue;
			const sitemap = toUrl(value, origin);
			if (sitemap) sitemaps.push(sitemap);
			continue;
		}
		if (field === "user-agent") {
			if (group.allows.length || group.disallows.length) flush();
			if (group.agents.length >= MAX_AGENTS_PER_GROUP) truncated = true;
			else group.agents.push(value.toLowerCase());
			continue;
		}
		if (field !== "allow" && field !== "disallow") continue;
		if (rules >= MAX_RULES) {
			truncated = true;
			continue;
		}
		if (!value) continue;
		if (field === "allow") group.allows.push(toRule(value));
		else group.disallows.push(toRule(value));
		rules++;
	}
	flush();
	if (truncated) return closedRobots();

	const { allows, disallows } = rulesForAgent(groups, userAgent);

	return {
		sitemaps,
		allows,
		disallows,
		allowed(url) {
			const parsed = new URL(url);
			const path = canonicalRobotsPath(`${parsed.pathname}${parsed.search}`);
			const allow = strongestMatch(path, allows);
			const disallow = strongestMatch(path, disallows);
			return allow >= disallow;
		},
	};

	function flush() {
		if (group.agents.length || group.allows.length || group.disallows.length)
			groups.push(group);
		group = newGroup();
	}
}

function* robotsLines(body: string) {
	let start = 0;
	for (
		let lines = 0;
		lines < MAX_ROBOTS_LINES && start <= body.length;
		lines++
	) {
		const end = body.indexOf("\n", start);
		if (end < 0) {
			yield body.slice(start);
			return;
		}
		const line = body.slice(start, end);
		yield line.endsWith("\r") ? line.slice(0, -1) : line;
		start = end + 1;
	}
	if (start < body.length) yield undefined;
}

function openRobots(): Robots {
	return { sitemaps: [], allows: [], disallows: [], allowed: () => true };
}

function closedRobots(): Robots {
	return {
		sitemaps: [],
		allows: [],
		disallows: [{ specificity: 1, matches: () => true }],
		allowed: () => false,
	};
}

type RobotsGroup = { agents: string[]; allows: Rule[]; disallows: Rule[] };

function newGroup(): RobotsGroup {
	return {
		agents: [],
		allows: [],
		disallows: [],
	};
}

function rulesForAgent(groups: RobotsGroup[], userAgent: string) {
	const products = new Set(
		userAgent.toLowerCase().match(/[a-z][a-z0-9_-]*(?=\/|\b)/g) ?? [],
	);
	let best = -1;
	let allows: Rule[] = [];
	let disallows: Rule[] = [];
	for (const group of groups) {
		let match = -1;
		for (const agent of group.agents) {
			const score = agent === "*" ? 0 : products.has(agent) ? agent.length : -1;
			if (score > match) match = score;
		}
		if (match < 0 || match < best) continue;
		if (match > best) {
			best = match;
			allows = [];
			disallows = [];
		}
		allows.push(...group.allows);
		disallows.push(...group.disallows);
	}
	return { allows, disallows };
}

function strongestMatch(path: string, rules: Rule[]) {
	let best = 0;
	for (const rule of rules) {
		if (rule.matches(path) && rule.specificity > best) best = rule.specificity;
	}
	return best;
}

function toRule(value: string): Rule {
	const anchored = value.endsWith("$");
	const body = canonicalRobotsPath(anchored ? value.slice(0, -1) : value);
	const segments = body.split("*");
	return {
		specificity: robotsOctetLength(body.replaceAll("*", "")),
		matches: (path) => wildcardMatch(path, segments, anchored),
	};
}

function robotsOctetLength(value: string) {
	let length = 0;
	for (let index = 0; index < value.length; length++) {
		index += /^%[0-9A-F]{2}/.test(value.slice(index, index + 3)) ? 3 : 1;
	}
	return length;
}

function canonicalRobotsPath(value: string) {
	let output = "";
	for (let index = 0; index < value.length; ) {
		const char = value[index]!;
		const encoded = value.slice(index, index + 3);
		if (char === "%" && /^%[0-9a-f]{2}$/i.test(encoded)) {
			const byte = Number.parseInt(encoded.slice(1), 16);
			output += isUnreserved(byte)
				? String.fromCharCode(byte)
				: `%${encoded.slice(1).toUpperCase()}`;
			index += 3;
			continue;
		}
		const codePoint = value.codePointAt(index)!;
		const literal = String.fromCodePoint(codePoint);
		if (codePoint <= 0x7f) output += literal;
		else {
			for (const byte of textEncoder.encode(literal)) {
				output += `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
			}
		}
		index += literal.length;
	}
	return output;
}

function isUnreserved(byte: number) {
	return (
		(byte >= 0x41 && byte <= 0x5a) ||
		(byte >= 0x61 && byte <= 0x7a) ||
		(byte >= 0x30 && byte <= 0x39) ||
		byte === 0x2d ||
		byte === 0x2e ||
		byte === 0x5f ||
		byte === 0x7e
	);
}

function wildcardMatch(
	path: string,
	segments: string[],
	anchored: boolean,
): boolean {
	const first = segments[0] ?? "";
	if (!path.startsWith(first)) return false;
	if (segments.length === 1) return anchored ? path === first : true;

	let pos = first.length;
	const lastIndex = segments.length - 1;
	for (let i = 1; i < (anchored ? lastIndex : segments.length); i++) {
		const segment = segments[i]!;
		if (!segment) continue;
		const found = path.indexOf(segment, pos);
		if (found < 0) return false;
		pos = found + segment.length;
	}

	if (!anchored) return true;
	const last = segments[lastIndex] ?? "";
	if (!last) return true;
	const start = path.length - last.length;
	return start >= pos && path.startsWith(last, start);
}

function toUrl(value: string, origin: string) {
	try {
		return new URL(value, origin).href;
	} catch {
		return undefined;
	}
}
