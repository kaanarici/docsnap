export function urlWithoutFragment(raw: string, base?: string | URL): string {
	const url = new URL(raw, base);
	url.hash = "";
	const search = canonicalUrlSearch(url);
	url.search = "";
	return `${url.href}${search}`;
}

export function canonicalUrlSearch(url: URL) {
	if (!url.search) return "";
	const params = [...url.searchParams.entries()].sort(([left], [right]) =>
		left < right ? -1 : left > right ? 1 : 0,
	);
	return `?${new URLSearchParams(params).toString()}`;
}

export function classifyDiscoveryResource(
	raw: string | URL,
	base?: string | URL,
): { url: string; source: "llms" } | undefined {
	try {
		const url = new URL(raw, base);
		if (!["http:", "https:"].includes(url.protocol)) return undefined;
		if (url.username || url.password) return undefined;
		url.hash = "";
		url.pathname = url.pathname.replace(/\/{2,}/g, "/");
		if (!url.pathname) url.pathname = "/";
		if (isLlmsResourcePath(url.pathname))
			return { url: url.href, source: "llms" };
		return undefined;
	} catch {
		return undefined;
	}
}

export function looksLikeSpecificContentUrl(raw: string): boolean {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		return false;
	}
	const segments = url.pathname.split("/").filter(Boolean);
	if (segments.length === 0) return false;
	const last = segments[segments.length - 1] ?? "";
	return (
		/\.(?:html?|mdx?|txt|json|rst)$/i.test(last) ||
		isDocumentPath(last) ||
		segments.length >= 3 ||
		(segments.length >= 2 && !url.pathname.endsWith("/"))
	);
}

export function isDocumentPath(path: string) {
	return /\.(?:doc|docx|docm|ppt|pps|pot|pptx|pptm|ppsx|ppsm|xls|xlsx|xlsm|xlsb|odt|ods|odp|rtf|epub|csv|pdf)$/i.test(
		path,
	);
}

export function isLlmsResourcePath(pathname: string): boolean {
	return /\/llms(?:-(?:full|ctx(?:-full)?))?\.(?:md|txt)$/i.test(pathname);
}
