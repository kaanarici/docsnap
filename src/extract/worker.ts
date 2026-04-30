import { extractPage } from "./html.ts";

self.onmessage = async (event) => {
	const { id, input } = event.data;
	try {
		self.postMessage({ id, record: await extractPage(input) });
	} catch (error) {
		self.postMessage({
			id,
			error: error instanceof Error ? error.message : String(error),
		});
	}
};
