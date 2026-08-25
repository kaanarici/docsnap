export type ResultError = {
	code: string;
	message: string;
	retryable: boolean;
	suggestion: string;
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

export function failureResult(
	error: ResultError,
	next = error.suggestion,
	warnings: string[] = [],
) {
	const { message, suggestion: _suggestion, ...details } = error;
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
