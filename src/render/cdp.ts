import type { Readable, Writable } from "node:stream";
import { StringDecoder } from "node:string_decoder";

type CdpError = {
	message: string;
	code?: number;
	data?: unknown;
};

type CdpIncoming = {
	id?: number;
	sessionId?: string;
	method?: string;
	params?: unknown;
	result?: unknown;
	error?: CdpError;
};

type Pending = {
	method: string;
	resolve: (value: CdpIncoming) => void;
	reject: (error: Error) => void;
	timer: ReturnType<typeof setTimeout>;
};

type EventHandler = (message: CdpIncoming) => void | Promise<void>;

export type CdpConnectionOptions = {
	maxFrameBytes?: number;
	onHandlerError?: (error: unknown, method: string) => void;
};

const defaultMaxFrameBytes = 32 * 1024 * 1024;

export class CdpConnection {
	private buffer = "";
	// buffers incomplete multibyte utf-8 sequences split across pipe chunks
	private readonly decoder = new StringDecoder("utf8");
	private closed: Error | undefined;
	private nextId = 1;
	private pending = new Map<number, Pending>();
	private handlers = new Map<string, Set<EventHandler>>();
	private readonly maxFrameBytes: number;
	private readonly onHandlerError: (error: unknown, method: string) => void;

	constructor(
		private readonly toBrowser: Writable,
		private readonly fromBrowser: Readable,
		options: CdpConnectionOptions = {},
	) {
		this.maxFrameBytes = options.maxFrameBytes ?? defaultMaxFrameBytes;
		this.onHandlerError = options.onHandlerError ?? (() => {});
		this.fromBrowser.on("data", (chunk: Buffer) => this.read(chunk));
		this.fromBrowser.on("error", (error) => this.close(error));
		this.toBrowser.on("error", (error) => this.close(error));
		this.fromBrowser.on("close", () =>
			this.close(new Error("CDP connection closed")),
		);
		this.toBrowser.on("close", () =>
			this.close(new Error("CDP connection closed")),
		);
	}

	send<T = unknown>(
		method: string,
		params: object = {},
		sessionId?: string,
		timeoutMs = 10_000,
	): Promise<T> {
		if (this.closed) return Promise.reject(this.closed);
		const id = this.nextId++;
		const payload = { id, method, params, ...(sessionId ? { sessionId } : {}) };
		return new Promise<T>((resolve, reject) => {
			const timer = setTimeout(() => {
				if (!this.pending.delete(id)) return;
				reject(new Error(`CDP timeout: ${method}`));
			}, timeoutMs);
			this.pending.set(id, {
				method,
				resolve: (message) => resolve(message.result as T),
				reject,
				timer,
			});
			try {
				this.toBrowser.write(`${JSON.stringify(payload)}\0`);
			} catch (error) {
				this.close(error instanceof Error ? error : new Error(String(error)));
			}
		});
	}

	on(method: string, handler: EventHandler): () => void {
		const set = this.handlers.get(method) ?? new Set<EventHandler>();
		set.add(handler);
		this.handlers.set(method, set);
		return () => {
			set.delete(handler);
			if (set.size === 0) this.handlers.delete(method);
		};
	}

	close(cause = new Error("CDP connection closed")): void {
		const error = cause instanceof Error ? cause : new Error(String(cause));
		this.closed ??= error;
		for (const [id, item] of this.pending) {
			clearTimeout(item.timer);
			item.reject(error);
			this.pending.delete(id);
		}
	}

	private read(chunk: Buffer): void {
		if (this.closed) return;
		this.buffer += this.decoder.write(chunk);
		if (Buffer.byteLength(this.buffer, "utf8") > this.maxFrameBytes) {
			this.destroy(new Error(`CDP frame exceeds ${this.maxFrameBytes} bytes`));
			return;
		}
		let zero = this.buffer.indexOf("\0");
		while (zero >= 0) {
			const raw = this.buffer.slice(0, zero);
			this.buffer = this.buffer.slice(zero + 1);
			zero = this.buffer.indexOf("\0");
			if (raw) {
				try {
					this.dispatch(JSON.parse(raw) as CdpIncoming);
				} catch (error) {
					this.destroy(
						error instanceof Error ? error : new Error(String(error)),
					);
					return;
				}
			}
		}
	}

	private dispatch(message: CdpIncoming): void {
		if (message.id !== undefined) {
			const item = this.pending.get(message.id);
			if (!item) return;
			clearTimeout(item.timer);
			this.pending.delete(message.id);
			if (message.error) {
				item.reject(new Error(`CDP ${item.method}: ${message.error.message}`));
			} else {
				item.resolve(message);
			}
			return;
		}
		const method = message.method;
		if (!method) return;
		for (const handler of this.handlers.get(method) ?? []) {
			void Promise.resolve()
				.then(() => handler(message))
				.catch((error) => this.onHandlerError(error, method));
		}
	}

	private destroy(cause: Error): void {
		this.buffer = "";
		this.close(cause);
		this.fromBrowser.destroy(cause);
		this.toBrowser.destroy(cause);
	}
}
