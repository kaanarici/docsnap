import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import {
	isJsonNumber,
	isJsonObject,
	isJsonString,
	type JsonObject,
	type JsonValue,
	parseJsonValue,
} from "../core/json.ts";
import { awaitWithSignal } from "../core/parallel.ts";

export type { JsonObject } from "../core/json.ts";

export type CdpEvent = {
	method: string;
	params: JsonObject;
	sessionId?: string;
};

export interface CdpClient {
	launchMs: number;
	onEvent: ((event: CdpEvent) => Promise<void>) | undefined;
	send(
		method: string,
		params?: JsonObject,
		sessionId?: string,
		signal?: AbortSignal,
	): Promise<JsonObject>;
	close(): Promise<void>;
}

export const chromePath =
	process.env["DOCSNAP_CHROME_PATH"] ??
	"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const chromeFlags = (
	"--headless=new\0--remote-debugging-pipe\0--host-resolver-rules=MAP * ~NOTFOUND\0--no-startup-window\0--no-first-run\0--no-default-browser-check\0" +
	"--disable-background-networking\0--disable-component-update\0--disable-default-apps\0--disable-extensions\0--disable-sync\0--disable-quic\0--disable-breakpad\0" +
	"--disable-features=ServiceWorker,SharedWorker,MediaRouter,OptimizationHints,Translate,Prerender2\0--metrics-recording-only\0--mute-audio\0--hide-scrollbars"
).split("\0");
const maxCdpFrameBytes = 32 * 1024 * 1024;
const oversizedFrame = (value: string) =>
	value.length > maxCdpFrameBytes / 4 &&
	Buffer.byteLength(value) > maxCdpFrameBytes;

type Pending = {
	method: string;
	resolve: (value: JsonObject) => void;
	reject: (error: Error) => void;
};

export function chromeExists() {
	return existsSync(chromePath);
}

export class Cdp implements CdpClient {
	readonly profile: string;
	readonly child: ChildProcess;
	launchMs = 0;
	onEvent: ((event: CdpEvent) => Promise<void>) | undefined;
	private id = 0;
	private buffer = "";
	private closed: Error | undefined;
	private readonly decoder = new StringDecoder("utf8");
	private readonly pending = new Map<number, Pending>();
	private readonly input: NodeJS.WritableStream;

	constructor(path: string) {
		this.profile = mkdtempSync(join(tmpdir(), "docsnap-chromium-"));
		let child: ChildProcess | undefined;
		try {
			child = spawn(path, [...chromeFlags, `--user-data-dir=${this.profile}`], {
				stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"],
			});
			const input = child.stdio[3];
			const output = child.stdio[4];
			if (!(input instanceof Writable) || !(output instanceof Readable)) {
				throw new Error("Chrome did not expose the CDP pipe streams");
			}
			this.child = child;
			this.input = input;
			output.on("data", (chunk) => this.read(chunk));
			for (const stream of [input, output]) {
				stream.on("error", (error) => this.stop(error));
				stream.on("close", () => this.stop(new Error("CDP connection closed")));
			}
			child.once("error", (error) => this.stop(error));
			child.once("exit", () => this.stop(new Error("Chrome exited")));
		} catch (error) {
			child?.kill("SIGKILL");
			rmSync(this.profile, { recursive: true, force: true });
			throw error;
		}
	}

	async start() {
		const started = performance.now();
		await this.send("Browser.getVersion");
		this.launchMs = performance.now() - started;
	}

	async send(
		method: string,
		params: JsonObject = {},
		sessionId?: string,
		signal?: AbortSignal,
	): Promise<JsonObject> {
		if (this.closed) throw this.closed;
		const id = ++this.id;
		const response = new Promise<JsonObject>((resolve, reject) =>
			this.pending.set(id, { method, resolve, reject }),
		);
		const request = { id, method, params };
		const serialized = sessionId ? { ...request, sessionId } : request;
		this.input.write(`${JSON.stringify(serialized)}\0`);
		try {
			const timeout = AbortSignal.timeout(15_000);
			return await awaitWithSignal(
				response,
				signal ? AbortSignal.any([signal, timeout]) : timeout,
			);
		} finally {
			this.pending.delete(id);
		}
	}

	async close() {
		try {
			const alive = () =>
				this.child.exitCode === null && this.child.signalCode === null;
			try {
				await waitAtMost(this.send("Browser.close"), 1_000);
			} catch {
				this.child.kill("SIGTERM");
			}
			if (alive()) {
				await waitAtMost(once(this.child, "exit"), 2_000);
			}
			if (alive()) {
				this.child.kill("SIGKILL");
				await waitAtMost(once(this.child, "exit"), 1_000);
			}
		} finally {
			this.stop(new Error("Renderer closed"));
			rmSync(this.profile, { recursive: true, force: true });
		}
	}

	private read(chunk: Buffer) {
		if (this.closed) return;
		this.buffer += this.decoder.write(chunk);
		for (let zero = this.buffer.indexOf("\0"); zero >= 0; ) {
			const raw = this.buffer.slice(0, zero);
			this.buffer = this.buffer.slice(zero + 1);
			zero = this.buffer.indexOf("\0");
			if (!raw) continue;
			if (oversizedFrame(raw)) {
				this.fail(new Error(`CDP frame exceeds ${maxCdpFrameBytes} bytes`));
				return;
			}
			let parsed: JsonValue;
			try {
				parsed = parseJsonValue(raw);
			} catch (error) {
				this.fail(error instanceof Error ? error : new Error(String(error)));
				return;
			}
			if (!isJsonObject(parsed)) {
				this.fail(new Error("CDP frame is not an object"));
				return;
			}
			const message = parsed;
			const id = message["id"];
			if (isJsonNumber(id)) {
				const item = this.pending.get(id);
				if (!item) continue;
				this.pending.delete(id);
				const error = message["error"];
				if (error) {
					item.reject(
						new Error(
							`CDP ${item.method}: ${isJsonObject(error) ? String(error["message"] ?? "error") : "error"}`,
						),
					);
					continue;
				}
				const result = message["result"];
				if (isJsonObject(result)) item.resolve(result);
				else item.reject(new Error(`CDP ${item.method}: invalid result`));
			} else {
				const event = cdpEvent(message);
				if (event && this.onEvent) this.onEvent(event).catch(() => undefined);
			}
		}
		if (oversizedFrame(this.buffer)) {
			this.fail(new Error(`CDP frame exceeds ${maxCdpFrameBytes} bytes`));
		}
	}

	private stop(error: Error) {
		if (this.closed) return;
		this.closed = error;
		for (const item of this.pending.values()) item.reject(error);
		this.pending.clear();
	}

	private fail(error: Error) {
		this.buffer = "";
		this.stop(error);
		this.child.kill("SIGKILL");
	}
}

function cdpEvent(message: JsonObject): CdpEvent | undefined {
	const method = message["method"];
	const params = message["params"];
	const sessionId = message["sessionId"];
	if (
		!isJsonString(method) ||
		!isJsonObject(params) ||
		(sessionId !== undefined && !isJsonString(sessionId))
	) {
		return;
	}
	return sessionId ? { method, params, sessionId } : { method, params };
}

async function waitAtMost<T>(promise: Promise<T>, milliseconds: number) {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<void>((resolve) => {
		timer = setTimeout(resolve, milliseconds);
		timer.unref?.();
	});
	try {
		await Promise.race([promise, timeout]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}
