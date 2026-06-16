export function httpResponse(
	url: string,
	status: number,
	body: string,
	contentType = "text/html",
) {
	return {
		url,
		status,
		headers: {
			get: (name: string) => (name === "content-type" ? contentType : null),
			getSetCookie: () => [],
		},
		body: new TextEncoder().encode(body),
	};
}

export function html(body: string) {
	return typed(body, "text/html");
}

export function typed(body: string, contentType: string, status = 200) {
	return new Response(body, {
		status,
		headers: { "content-type": contentType },
	});
}
