export function helpData(details: string) {
	return {
		tool: "docsnap",
		commands: [
			{
				name: "capture",
				description:
					"Capture one page, a site, or a batch of separate corpora.",
				writes: ["local corpus", "shared HTTP cache"],
			},
			{
				name: "map",
				description: "Discover capture candidates without writing a corpus.",
				writes: ["shared HTTP cache"],
			},
			{
				name: "refresh",
				description: "Recapture an existing corpus from its stored URL.",
				writes: ["local corpus", "shared HTTP cache"],
			},
		],
		details,
	};
}
