import { extractPage } from "./html.ts";

self.onmessage = async (event) => {
	const { id, input, body } = event.data;
	try {
		self.postMessage({
			id,
			page: await extractPage({
				...input,
				result: { ...input.result, body: new TextDecoder().decode(body) },
			}),
		});
	} catch (error) {
		self.postMessage({
			id,
			error: error instanceof Error ? error.message : String(error),
		});
	}
};
