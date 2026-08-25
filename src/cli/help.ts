export function helpData(details: string) {
	return {
		tool: "docsnap",
		description:
			"Capture public documentation and text-heavy sites into local Markdown for coding agents.",
		output: {
			success: "One JSON result on stdout.",
			failure: "One JSON error on stderr and a non-zero exit code.",
			progress: "Stderr; disabled by --quiet.",
		},
		commands: [
			{
				name: "capture",
				usage: "docsnap <url> [flags]",
				description: "Capture one page or discover and capture a site.",
				effects: "idempotent",
				writes: ["local corpus", "shared HTTP cache"],
			},
			{
				name: "map",
				usage: "docsnap map <url> [flags]",
				description: "Discover capture candidates without writing a corpus.",
				effects: "read_only",
			},
			{
				name: "fetch",
				usage: "docsnap fetch <url> [question] [flags]",
				description:
					"Reuse, refresh, or capture a corpus and return pages or cited passages.",
				effects: "idempotent",
				writes: ["local corpus", "shared HTTP cache"],
			},
			{
				name: "refresh",
				usage: "docsnap refresh <corpus-dir> [flags]",
				description: "Refresh an existing corpus from its original URL.",
				effects: "idempotent",
				writes: ["local corpus", "shared HTTP cache"],
			},
			{
				name: "list",
				usage: "docsnap list [root] [flags]",
				description: "List valid local corpora.",
				effects: "read_only",
			},
			{
				name: "search",
				usage: "docsnap search <corpus-dir> <query> [flags]",
				description: "Search one corpus or every corpus under a root.",
				effects: "read_only",
			},
		],
		details,
	};
}
