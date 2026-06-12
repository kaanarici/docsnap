import type { Config } from "../core/types.ts";
import { loadRobots, type Robots } from "../discover/robots.ts";
import { assertPublicHttpUrl, validatePublicHttpUrl } from "../security/url.ts";

export type RenderRequest = {
	url: string;
	method?: string;
	resourceType?: string;
	isNavigationRequest?: boolean;
};

export type RenderDecision = {
	allow: boolean;
	reason?: string;
};

export type RenderPolicyOptions = {
	robotsLoader?: (origin: string, config: Config) => Promise<Robots>;
	publicUrlCheck?: (url: string) => Promise<string | undefined>;
};

const pageRequestLimit = 64;
const originPageRequestLimit = 32;
const originRunRequestLimit = 200;
const pageInterceptLimit = 256;
const pageOriginLimit = 32;
const decisionConcurrencyLimit = 8;
const blockedResourceTypes = new Set([
	"Image",
	"Media",
	"Font",
	"Manifest",
	"Ping",
	"WebSocket",
]);
const trackerHosts =
	/(^|\.)(google-analytics\.com|googletagmanager\.com|doubleclick\.net|facebook\.net|facebook\.com|hotjar\.com|segment\.io|segment\.com|mixpanel\.com|amplitude\.com|fullstory\.com|clarity\.ms|posthog\.com)$/i;
const trackerPaths =
	/\/(?:collect|analytics\.js|gtag\/js|fbevents\.js|hotjar-|fullstory|rum|beacon)(?:[/?#]|$)/i;
const blockedRoutes =
	/(?:^|\/)(?:login|sign-?in|sign-?up|signup|register|captcha|paywall)(?:\/|$)/i;

export class RenderPolicy {
	private readonly robotsCache = new Map<string, Promise<Robots>>();
	private readonly originRunCounts = new Map<string, number>();
	private readonly robotsLoader: (
		origin: string,
		config: Config,
	) => Promise<Robots>;
	private readonly publicUrlCheck: (url: string) => Promise<string | undefined>;

	constructor(
		private readonly config: Config,
		options: RenderPolicyOptions = {},
	) {
		this.robotsLoader = options.robotsLoader ?? loadRobots;
		this.publicUrlCheck = options.publicUrlCheck ?? defaultPublicUrlCheck;
	}

	beginPage(): RenderPagePolicy {
		return new RenderPagePolicy(this);
	}

	async checkMainNavigation(url: string): Promise<string | undefined> {
		return await this.allowedBySafetyAndRobots(url);
	}

	async allowedBySafetyAndRobots(url: string): Promise<string | undefined> {
		const publicError = await this.publicUrlCheck(url);
		if (publicError) return publicError;
		const parsed = httpUrl(url);
		if (!parsed) return "URL must use http or https";
		if (isBlockedRoute(parsed)) return "blocked route";
		if (this.config.ignoreRobots) return undefined;
		const robots = await this.robotsFor(parsed.origin);
		return robots.allowed(url) ? undefined : "blocked by robots.txt";
	}

	countOrigin(origin: string): boolean {
		const current = this.originRunCounts.get(origin) ?? 0;
		if (current >= originRunRequestLimit) return false;
		this.originRunCounts.set(origin, current + 1);
		return true;
	}

	private robotsFor(origin: string) {
		const current = this.robotsCache.get(origin);
		if (current) return current;
		const next = this.robotsLoader(origin, this.config);
		this.robotsCache.set(origin, next);
		return next;
	}
}

export class RenderPagePolicy {
	resourceRequests = 0;
	blockedRequests = 0;
	private interceptedRequests = 0;
	private reservedResourceRequests = 0;
	private inFlightDecisions = 0;
	private readonly originPageCounts = new Map<string, number>();
	private readonly seenOrigins = new Set<string>();
	private readonly decisionWaiters: Array<() => void> = [];

	constructor(private readonly run: RenderPolicy) {}

	async decide(request: RenderRequest): Promise<RenderDecision> {
		const reservation = this.reserve(request);
		if (!reservation.allow) return reservation;
		const error = await this.withDecisionSlot(() =>
			this.run.allowedBySafetyAndRobots(request.url),
		);
		if (error) return this.block(error);
		if ("countsAsResource" in reservation && reservation.countsAsResource) {
			this.resourceRequests++;
		}
		return { allow: true };
	}

	private reserve(
		request: RenderRequest,
	): RenderDecision | { allow: true; countsAsResource: boolean } {
		this.interceptedRequests++;
		if (this.interceptedRequests > pageInterceptLimit) {
			return this.block("page intercepted request budget exceeded");
		}
		if ((request.method ?? "GET").toUpperCase() !== "GET") {
			return this.block("blocked non-GET request");
		}
		if (shouldBlockResourceType(request.resourceType)) {
			return this.block("blocked resource type");
		}
		const url = httpUrl(request.url);
		if (!url) return this.block("URL must use http or https");
		if (isTracker(url)) return this.block("blocked tracker");
		if (isBlockedRoute(url)) return this.block("blocked route");
		if (!this.seenOrigins.has(url.origin)) {
			if (this.seenOrigins.size >= pageOriginLimit) {
				return this.block("page origin budget exceeded");
			}
			this.seenOrigins.add(url.origin);
		}
		const countsAsResource = countsAgainstBudget(request);
		if (!countsAsResource) return { allow: true, countsAsResource };
		if (this.reservedResourceRequests >= pageRequestLimit) {
			return this.block("page resource budget exceeded");
		}
		const originPage = this.originPageCounts.get(url.origin) ?? 0;
		if (originPage >= originPageRequestLimit) {
			return this.block("page origin resource budget exceeded");
		}
		if (!this.run.countOrigin(url.origin)) {
			return this.block("run origin resource budget exceeded");
		}
		this.originPageCounts.set(url.origin, originPage + 1);
		this.reservedResourceRequests++;
		return { allow: true, countsAsResource };
	}

	private async withDecisionSlot<T>(work: () => Promise<T>): Promise<T> {
		if (this.inFlightDecisions >= decisionConcurrencyLimit) {
			await new Promise<void>((resolve) => this.decisionWaiters.push(resolve));
		}
		this.inFlightDecisions++;
		try {
			return await work();
		} finally {
			this.inFlightDecisions--;
			this.decisionWaiters.shift()?.();
		}
	}

	private block(reason: string): RenderDecision {
		this.blockedRequests++;
		return { allow: false, reason };
	}
}

function countsAgainstBudget(request: RenderRequest) {
	return request.resourceType !== "Document" && !request.isNavigationRequest;
}

function shouldBlockResourceType(type = "") {
	return blockedResourceTypes.has(type);
}

function isTracker(url: URL) {
	return trackerHosts.test(url.hostname) || trackerPaths.test(url.pathname);
}

function isBlockedRoute(url: URL) {
	return blockedRoutes.test(url.pathname);
}

function httpUrl(raw: string): URL | undefined {
	try {
		const url = new URL(raw);
		return url.protocol === "http:" || url.protocol === "https:"
			? url
			: undefined;
	} catch {
		return undefined;
	}
}

async function defaultPublicUrlCheck(url: string) {
	const syntax = validatePublicHttpUrl(url);
	if (syntax) return syntax;
	try {
		await assertPublicHttpUrl(url);
		return undefined;
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
}
