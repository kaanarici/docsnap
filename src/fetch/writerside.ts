import type { Config } from "../core/types.ts";
import type { FetchTransport } from "./transport.ts";

type RequestHeaders = { accept: string; "user-agent": string; cookie?: string };

export async function withWritersideTopic(
	html: string,
	base: string,
	headers: RequestHeaders,
	config: Config,
	fetchTransport: FetchTransport,
): Promise<string> {
	const topicUrl = writersideTopicUrl(html, base);
	if (!topicUrl) return html;
	try {
		const cookie = headers.cookie;
		const response = await fetchTransport(
			topicUrl,
			{
				accept: "application/json,text/plain;q=0.9,*/*;q=0.8",
				"user-agent": headers["user-agent"] ?? config.userAgent,
				...(cookie ? { cookie } : {}),
			},
			config,
		);
		if (response.status < 200 || response.status > 299) return html;
		const topic = new TextDecoder().decode(response.body).trim();
		if (!topic) return html;
		return `${html}\n${writersideNav(topic, base)}<script type="application/json" id="__DOCSNAP_WRITERSIDE_TOPIC__">${safeScriptJson(topic)}</script>`;
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
	let json: unknown;
	try {
		json = JSON.parse(topic);
	} catch {
		return [];
	}
	const origin = new URL(base).origin;
	const out = new Set<string>();
	const visit = (value: unknown) => {
		if (Array.isArray(value)) {
			for (const item of value) visit(item);
			return;
		}
		if (!value || typeof value !== "object") return;
		const record = value as { url?: unknown } & Record<string, unknown>;
		if (typeof record.url === "string") {
			try {
				const url = new URL(record.url, base);
				if (url.origin === origin) {
					url.hash = "";
					out.add(url.href);
				}
			} catch {}
		}
		for (const item of Object.values(record)) visit(item);
	};
	visit(json);
	return [...out].slice(0, 200);
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
