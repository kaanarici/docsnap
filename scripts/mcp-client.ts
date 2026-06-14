import { resolve } from "node:path";

type RpcMessage = {
	id?: number | null;
	result?: unknown;
	error?: { code?: number; message: string };
};

type McpProcess = ReturnType<typeof Bun.spawn> & {
	stdin: { write(text: string): unknown; end(): unknown };
	stdout: ReadableStream<Uint8Array>;
	stderr: ReadableStream<Uint8Array>;
};

export class McpClient {
	private readonly proc: McpProcess;
	private readonly decoder = new TextDecoder();
	private readonly pending: Array<{
		resolve: (message: unknown) => void;
		reject: (error: Error) => void;
	}> = [];
	private readonly queued: unknown[] = [];
	private nextId = 1;
	private pumpError: Error | undefined;
	private readonly stderr: Promise<string>;

	constructor(allowedOrigin: string, cwd: string = process.cwd()) {
		this.proc = Bun.spawn({
			cmd: ["bun", resolve("bin/docsnap"), "mcp"],
			cwd,
			env: { ...cleanEnv(), DOCSNAP_ALLOW_TEST_HOST: allowedOrigin },
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
		}) as McpProcess;
		this.stderr = new Response(this.proc.stderr).text();
		void this.pump();
	}

	request(method: string, params: unknown): Promise<unknown> {
		const id = this.nextId++;
		this.proc.stdin.write(
			`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`,
		);
		return this.next().then((value) => {
			const message = value as RpcMessage;
			if (message.id !== id)
				throw new Error(`unexpected response id ${message.id}`);
			if (message.error) throw new Error(message.error.message);
			return message.result;
		});
	}

	raw(text: string): Promise<unknown> {
		this.proc.stdin.write(text);
		return this.next();
	}

	notify(method: string, params: unknown): void {
		this.proc.stdin.write(
			`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`,
		);
	}

	async stop(): Promise<void> {
		this.proc.stdin.end();
		const exit = await Promise.race([
			this.proc.exited,
			new Promise<"timeout">((resolve) =>
				setTimeout(() => resolve("timeout"), 1000),
			),
		]);
		if (exit === "timeout") this.proc.kill();
		await this.stderr;
	}

	private async pump(): Promise<void> {
		let buffer = "";
		try {
			const reader = this.proc.stdout.getReader();
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				buffer += this.decoder.decode(value, { stream: true });
				for (;;) {
					const newline = buffer.indexOf("\n");
					if (newline < 0) break;
					const line = buffer.slice(0, newline).trim();
					buffer = buffer.slice(newline + 1);
					if (line) this.push(JSON.parse(line));
				}
			}
			if (buffer.trim()) this.push(JSON.parse(buffer.trim()));
		} catch (error) {
			this.fail(error instanceof Error ? error : new Error(String(error)));
		}
	}

	private next(): Promise<unknown> {
		if (this.pumpError) return Promise.reject(this.pumpError);
		const message = this.queued.shift();
		if (message) return Promise.resolve(message);
		return new Promise((resolve, reject) =>
			this.pending.push({ resolve, reject }),
		);
	}

	private push(message: unknown): void {
		const waiter = this.pending.shift();
		if (waiter) waiter.resolve(message);
		else this.queued.push(message);
	}

	private fail(error: Error): void {
		this.pumpError = error;
		for (const waiter of this.pending.splice(0)) waiter.reject(error);
	}
}

function cleanEnv(): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value !== undefined) env[key] = value;
	}
	return env;
}
