import packageJson from "../../package.json";

export const runFiles = {
	manifest: "manifest.jsonl",
	summary: "summary.json",
} as const;

export const corpusGenerator = `docsnap@${packageJson.version}`;
