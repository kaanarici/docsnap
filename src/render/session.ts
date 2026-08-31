import type {
	FetchedUrl,
	FetchResult,
	PageRecord,
	PipelineConfig,
	PipelineResult,
} from "../core/types.ts";
import { isRecoverableAppShell } from "../extract/app-shell.ts";
import {
	type ChromiumRenderer,
	type ChromiumRenderResult,
	openChromiumRenderer,
} from "./chromium.ts";

export const maxConsecutiveRenderMisses = 3;

export type ChromeStopReason = "budget" | "no_recovery" | "no_new_urls";

export type ChromeSession = {
	renderer: "chrome-cdp";
	attempted: number;
	rendered: number;
	recovered: number;
	failed: number;
	renderMs: number;
	skipped: number;
	truncated: boolean;
	stopReason?: ChromeStopReason;
	unavailable?: string;
	misses: number;
	browser?: ChromiumRenderer;
};

export function createChromeSession(): ChromeSession {
	return {
		renderer: "chrome-cdp",
		attempted: 0,
		rendered: 0,
		recovered: 0,
		failed: 0,
		renderMs: 0,
		skipped: 0,
		truncated: false,
		misses: 0,
	};
}

export function chromeBudgetMs(config: PipelineConfig, pages = config.max) {
	return Math.min(120_000, Math.max(config.timeoutMs, pages * 5_000));
}

export function chromeStopped(session: ChromeSession) {
	return Boolean(
		session.stopReason ||
			session.unavailable ||
			session.misses >= maxConsecutiveRenderMisses,
	);
}

export function skipChrome(
	session: ChromeSession,
	count: number,
	reason?: ChromeStopReason,
) {
	session.skipped += count;
	if (!reason) return;
	session.truncated = true;
	session.stopReason = reason;
}

export function needsChrome(record: PageRecord, shell: boolean) {
	if (record.ok) return record.kind ? record.kind === "app-shell" : shell;
	return shell && record.failureKind === "empty";
}

export function needsChromeFetch(result: FetchResult) {
	return (
		result.ok &&
		!result.notModified &&
		Boolean(result.body) &&
		isRecoverableAppShell(result.body)
	);
}

export async function closeChromeSession(session: ChromeSession) {
	const browser = session.browser;
	delete session.browser;
	await browser?.close();
}

export async function renderChromePage(
	session: ChromeSession,
	input: FetchedUrl,
	config: PipelineConfig,
	remainingMs: number,
): Promise<ChromiumRenderResult | undefined> {
	if (remainingMs <= 0) {
		session.truncated = true;
		session.stopReason = "budget";
		return;
	}
	if (!(await ensureChrome(session, config)) || !session.browser) return;
	session.attempted++;
	const timeout = AbortSignal.timeout(
		Math.max(1, Math.min(config.timeoutMs, Math.ceil(remainingMs))),
	);
	const rendered = await session.browser.renderPage(input.result, {
		explicitSeed: input.wasSeed === true,
		signal: config.signal ? AbortSignal.any([timeout, config.signal]) : timeout,
	});
	session.renderMs += rendered.metrics.renderMs;
	session.truncated ||= rendered.metrics.truncated;
	return rendered;
}

export function chromeRunSummary(
	session: ChromeSession,
): PipelineResult["summary"]["render"] {
	if (session.attempted === 0) return;
	const stopReason =
		session.stopReason === "budget" || session.stopReason === "no_recovery"
			? session.stopReason
			: undefined;
	const summary: NonNullable<PipelineResult["summary"]["render"]> = {
		recovered: session.recovered,
		failed: session.failed,
		skipped: session.skipped,
		truncated: session.truncated,
	};
	if (stopReason) summary.stopReason = stopReason;
	if (session.unavailable) summary.unavailable = session.unavailable;
	return summary;
}

async function ensureChrome(session: ChromeSession, config: PipelineConfig) {
	if (session.unavailable || session.stopReason) return false;
	if (session.browser) return true;
	const opened = await openChromiumRenderer(config);
	if (!opened.ok) {
		session.attempted++;
		session.failed++;
		session.unavailable = opened.error;
		return false;
	}
	session.browser = opened.renderer;
	return true;
}
