export function dropFragmentAndQuery(url: URL): URL {
	url.hash = "";
	url.search = "";
	return url;
}

export function urlWithoutFragmentAndQuery(
	raw: string,
	base?: string | URL,
): string {
	return dropFragmentAndQuery(new URL(raw, base)).href;
}
