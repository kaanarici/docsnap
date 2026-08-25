import { isAbsolute } from "node:path";
import { listCorpora } from "../corpus/index.ts";
import type { ListInput } from "./args.ts";
import { successResult, writeResult } from "./result.ts";

export async function runList(input: ListInput): Promise<void> {
	const result = await listCorpora(input.rootDir, input.limit, input.cursor, {
		allowAbsoluteRoot: true,
		preserveAbsolutePaths: isAbsolute(input.rootDir),
	});
	const data = {
		rootDir: input.rootDir,
		corpora: result.corpora,
		scanTruncated: result.truncated,
		corporaSkipped: result.corporaSkipped,
		nextCursor: result.nextCursor,
	};
	const count = result.corpora.length;
	writeResult(
		successResult(
			data,
			`Found ${count} valid ${count === 1 ? "corpus" : "corpora"}.`,
			count
				? "Use a corpus or continue with the returned cursor."
				: "Capture a site before searching or fetching from the corpus library.",
			[
				...(result.truncated
					? ["The corpus scan stopped at its safety limit."]
					: []),
				...(result.corporaSkipped
					? [
							`Skipped ${result.corporaSkipped} unreadable or invalid ${result.corporaSkipped === 1 ? "directory" : "directories"}.`,
						]
					: []),
			],
		),
	);
}
