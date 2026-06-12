import { runJsonRpcServer } from "./jsonrpc.ts";

export async function runMcpServer(argv: string[]): Promise<void> {
	if (argv.length > 0) {
		process.stderr.write("docsnap mcp does not accept flags in v1\n");
		process.exitCode = 1;
		return;
	}
	await runJsonRpcServer({
		version: await packageVersion(),
		state: { corpora: new Set(), resourceCorpora: new Map() },
	});
}

async function packageVersion(): Promise<string> {
	const packageJson = (await Bun.file(
		new URL("../../package.json", import.meta.url),
	).json()) as { version?: unknown };
	return typeof packageJson.version === "string"
		? packageJson.version
		: "0.0.0";
}
