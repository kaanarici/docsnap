import { Defuddle } from "defuddle/node";

export type DefuddleParse = {
	content: string;
	title: string;
};

export async function parseWithDefuddle(
	document: Document,
	url: string,
): Promise<DefuddleParse | undefined> {
	document.querySelectorAll("script").forEach((script) => {
		if (
			script.getAttribute("type")?.split(";", 1)[0]?.trim().toLowerCase() ===
			"application/ld+json"
		) {
			script.remove();
		}
	});
	try {
		const parsed = await Defuddle(document, url, {
			markdown: true,
			useAsync: false,
			debug: false,
		});
		return { content: parsed.content, title: parsed.title };
	} catch {
		return undefined;
	}
}
