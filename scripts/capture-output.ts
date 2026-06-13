export async function captureOutput(run: () => Promise<void>) {
	const originalStdout = process.stdout.write;
	const originalStderr = process.stderr.write;
	const originalExitCode = process.exitCode;
	let stdout = "";
	let stderr = "";
	process.stdout.write = ((chunk: string | Uint8Array) => {
		stdout += chunk.toString();
		return true;
	}) as typeof process.stdout.write;
	process.stderr.write = ((chunk: string | Uint8Array) => {
		stderr += chunk.toString();
		return true;
	}) as typeof process.stderr.write;
	process.exitCode = undefined;
	try {
		await run();
		return { stdout, stderr, exitCode: process.exitCode };
	} finally {
		process.stdout.write = originalStdout;
		process.stderr.write = originalStderr;
		process.exitCode = originalExitCode ?? 0;
	}
}
