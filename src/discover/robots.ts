import type { Config } from "../core/types.ts";
import { fetchText } from "../fetch/fetcher.ts";

export type Robots = {
	sitemaps: string[];
	allows: Rule[];
	disallows: Rule[];
	allowed: (url: string) => boolean;
};

type Rule = {
	value: string;
	specificity: number;
	matches: (path: string) => boolean;
};

export async function loadRobots(
	origin: string,
	config: Config,
): Promise<Robots> {
	if (config.ignoreRobots) return openRobots();
	const response = await fetchText(
		`${origin}/robots.txt`,
		config,
		"text/plain,*/*;q=0.8",
	);
	if (!response.ok) {
		if (response.status >= 400 && response.status < 500) return openRobots();
		return closedRobots();
	}
	return parseRobots(response.body, origin, config.userAgent);
}

export function parseRobots(
	body: string,
	origin: string,
	userAgent = "docsnap",
): Robots {
	const sitemaps: string[] = [];
	const groups: Array<{ agents: string[]; allows: Rule[]; disallows: Rule[] }> =
		[];
	let group = newGroup();

	for (const raw of body.split(/\r?\n/)) {
		const line = raw.replace(/#.*/, "").trim();
		if (!line) continue;
		const [fieldRaw, ...rest] = line.split(":");
		const field = fieldRaw?.trim().toLowerCase();
		const value = rest.join(":").trim();
		if (field === "sitemap" && value) {
			const sitemap = toUrl(value, origin);
			if (sitemap) sitemaps.push(sitemap);
			continue;
		}
		if (field === "user-agent") {
			if (group.allows.length || group.disallows.length) flush();
			group.agents.push(value.toLowerCase());
			continue;
		}
		if (field !== "allow" && field !== "disallow") continue;
		if (field === "allow" && value) group.allows.push(toRule(value));
		if (field === "disallow" && value) group.disallows.push(toRule(value));
	}
	flush();

	const { allows, disallows } = rulesForAgent(groups, userAgent);

	return {
		sitemaps,
		allows,
		disallows,
		allowed(url) {
			const parsed = new URL(url);
			const path = `${parsed.pathname}${parsed.search}`;
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

function openRobots(): Robots {
	return { sitemaps: [], allows: [], disallows: [], allowed: () => true };
}

function closedRobots(): Robots {
	return {
		sitemaps: [],
		allows: [],
		disallows: [{ value: "/", specificity: 1, matches: () => true }],
		allowed: () => false,
	};
}

function newGroup() {
	return {
		agents: [] as string[],
		allows: [] as Rule[],
		disallows: [] as Rule[],
	};
}

function rulesForAgent(
	groups: Array<{ agents: string[]; allows: Rule[]; disallows: Rule[] }>,
	userAgent: string,
) {
	let best = -1;
	let allows: Rule[] = [];
	let disallows: Rule[] = [];
	for (const group of groups) {
		const match = Math.max(
			...group.agents.map((agent) => agentSpecificity(agent, userAgent)),
		);
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

function agentSpecificity(agent: string, userAgent: string) {
	if (agent === "*") return 0;
	const products: string[] =
		userAgent.toLowerCase().match(/[a-z][a-z0-9_-]*(?=\/|\b)/g) ?? [];
	return products.includes(agent) ? agent.length : -1;
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
	const body = anchored ? value.slice(0, -1) : value;
	const segments = body.split("*");
	return {
		value,
		specificity: value.replace(/[*$]/g, "").length,
		matches: (path) => wildcardMatch(path, segments, anchored),
	};
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
