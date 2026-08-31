export type ResultError = {
	code: string;
	message: string;
	next: string;
	retryable: boolean;
	details?: unknown;
};

export function successResult<T>(
	data: T,
	message: string,
	next: string,
	warnings: string[] = [],
) {
	return { ok: true, message, next, data, error: null, warnings };
}

export function failureResult(error: ResultError, warnings: string[] = []) {
	const { message, next, ...details } = error;
	return {
		ok: false,
		message,
		next,
		data: null,
		error: details,
		warnings,
	};
}

export function writeResult(result: ReturnType<typeof failureResult> | object) {
	const output = `${JSON.stringify(result)}\n`;
	if ("ok" in result && result.ok === false) process.stderr.write(output);
	else process.stdout.write(output);
}
