export function helpData(details: string) {
	return {
		tool: "docsnap",
		description: "Turn public web pages into local Markdown for coding agents.",
		output: {
			success: "One JSON result on stdout.",
			failure: "One JSON error on stderr and a non-zero exit code.",
		},
		commands: [
			{
				name: "capture",
				usage: "docsnap <url> [flags] | docsnap --stdin [flags]",
				description:
					"Capture one page, a site, or a batch of separate corpora.",
				effects: "idempotent",
				writes: ["local corpus", "shared HTTP cache"],
			},
			{
				name: "map",
				usage: "docsnap map <url> [flags]",
				description: "Discover capture candidates without writing a corpus.",
				effects: "idempotent",
				writes: ["shared HTTP cache"],
			},
			{
				name: "refresh",
				usage: "docsnap refresh <corpus-dir> [flags]",
				description: "Recapture an existing corpus from its stored URL.",
				effects: "idempotent",
				writes: ["local corpus", "shared HTTP cache"],
			},
		],
		details,
	};
}
