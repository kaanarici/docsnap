import {
	isJsonObject,
	isJsonString,
	type JsonValue,
	parseJsonValue,
} from "../core/json.ts";
import { awaitWithSignal } from "../core/parallel.ts";
import type { PipelineConfig } from "../core/types.ts";
import { maxPublicUrlChars } from "../security/url.ts";
import { requestPublicHttp } from "./transport.ts";

type RequestHeaders = { accept: string; "user-agent": string; cookie?: string };
const maxTopicNodes = 20_000;

export async function withWritersideTopic(
	html: string,
	base: string,
	headers: RequestHeaders,
	config: PipelineConfig,
	allowUrl?: (url: string) => boolean | Promise<boolean>,
	signal?: AbortSignal,
): Promise<string> {
	const topicUrl = writersideTopicUrl(html, base);
	if (!topicUrl) return html;
	// the topic JSON is a same-origin subrequest on its own path; respect robots
	// for it like every other secondary fetch
	signal?.throwIfAborted();
	if (
		allowUrl &&
		!(await awaitWithSignal(Promise.resolve(allowUrl(topicUrl)), signal))
	)
		return html;
	signal?.throwIfAborted();
	try {
		const remainingBytes = config.maxBytes - Buffer.byteLength(html);
		if (remainingBytes <= 0) return html;
		const cookie = headers.cookie;
		const requestHeaders: RequestHeaders = {
			accept: "application/json,text/plain;q=0.9,*/*;q=0.8",
			"user-agent": headers["user-agent"],
		};
		if (cookie) requestHeaders.cookie = cookie;
		const response = await requestPublicHttp(
			topicUrl,
			requestHeaders,
			config,
			signal
				? { signal, maxBytes: remainingBytes }
				: { maxBytes: remainingBytes },
		);
		if (response.status < 200 || response.status > 299) return html;
		const topic = new TextDecoder().decode(response.body).trim();
		if (!topic) return html;
		const enriched = `${html}\n${writersideNav(topic, base)}<script type="application/json" id="__DOCSNAP_WRITERSIDE_TOPIC__">${safeScriptJson(topic)}</script>`;
		return Buffer.byteLength(enriched) <= config.maxBytes ? enriched : html;
	} catch {
		return html;
	}
}

function writersideTopicUrl(html: string, base: string): string | undefined {
	if (!/\bdata-topic=|resources\.jetbrains\.com\/writerside/i.test(html))
		return undefined;
	const topic = html.match(
		/\bdata-topic\s*=\s*["']([^"']{1,300}\.json(?:\?[^"']*)?)["']/i,
	)?.[1];
	if (!topic) return undefined;
	try {
		const url = new URL(decodeAttribute(topic), base);
		if (url.origin !== new URL(base).origin) return undefined;
		url.hash = "";
		return url.href;
	} catch {
		return undefined;
	}
}

function decodeAttribute(value: string): string {
	return value
		.replace(/&amp;/g, "&")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'");
}

function writersideNav(topic: string, base: string): string {
	const links = writersideLinks(topic, base);
	if (links.length === 0) return "";
	return `<nav data-docsnap-writerside>${links
		.map((href) => `<a href="${escapeHtml(href)}">${escapeHtml(href)}</a>`)
		.join("")}</nav>`;
}

function writersideLinks(topic: string, base: string): string[] {
	let json: JsonValue;
	try {
		json = parseJsonValue(topic);
	} catch {
		return [];
	}
	const origin = new URL(base).origin;
	const out = new Set<string>();
	const pending: JsonValue[] = [json];
	let visited = 0;
	while (pending.length && visited++ < maxTopicNodes && out.size < 200) {
		const value = pending.pop()!;
		if (Array.isArray(value)) {
			const count = Math.min(
				value.length,
				maxTopicNodes - visited - pending.length,
			);
			for (let index = count - 1; index >= 0; index--) {
				pending.push(value[index]!);
			}
			continue;
		}
		if (!isJsonObject(value)) continue;
		const record = value;
		if (isJsonString(record["url"])) {
			try {
				const url = new URL(record["url"], base);
				if (url.origin === origin && url.href.length <= maxPublicUrlChars) {
					url.hash = "";
					out.add(url.href);
				}
			} catch {}
		}
		for (const key in record) {
			if (pending.length + visited >= maxTopicNodes) break;
			pending.push(record[key]!);
		}
	}
	return [...out];
}

function escapeHtml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/"/g, "&quot;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
}

function safeScriptJson(value: string): string {
	return value.replace(/<\/script/gi, "<\\/script");
}
