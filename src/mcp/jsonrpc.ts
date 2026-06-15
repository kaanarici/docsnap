import { StringDecoder } from "node:string_decoder";
import { logDiagnostic, type McpState } from "./access.ts";
import { listResources, readResource } from "./resources.ts";
import { callTool, listTools } from "./tools.ts";

type JsonRpcId = string | number | null;

type JsonRpcRequest = {
	jsonrpc: "2.0";
	id?: JsonRpcId;
	method: string;
	params?: unknown;
};

type ServerOptions = {
	version: string;
	state: McpState;
};

type RpcParams = Record<string, unknown> & {
	arguments?: unknown;
	name?: unknown;
	uri?: unknown;
};

const maxFrameBytes = 4 * 1024 * 1024;

export async function runJsonRpcServer(options: ServerOptions): Promise<void> {
	let buffer = "";
	// buffers incomplete multibyte utf-8 sequences split across stdin chunks
	const decoder = new StringDecoder("utf8");
	for await (const chunk of process.stdin) {
		buffer += decoder.write(chunk as Buffer);
		for (;;) {
			const newline = buffer.indexOf("\n");
			if (newline < 0) {
				if (Buffer.byteLength(buffer) > maxFrameBytes) {
					buffer = "";
					send(errorResponse(null, -32700, "Parse error"));
				}
				break;
			}
			const line = buffer.slice(0, newline).trim();
			buffer = buffer.slice(newline + 1);
			if (!line) continue;
			if (Buffer.byteLength(line) > maxFrameBytes) {
				send(errorResponse(null, -32700, "Parse error"));
				continue;
			}
			await handleLine(line, options);
		}
	}
	const tail = buffer.trim();
	if (!tail) return;
	if (Buffer.byteLength(tail) > maxFrameBytes) {
		send(errorResponse(null, -32700, "Parse error"));
		return;
	}
	await handleLine(tail, options);
}

async function handleLine(line: string, options: ServerOptions): Promise<void> {
	let message: unknown;
	try {
		message = JSON.parse(line);
	} catch {
		send(errorResponse(null, -32700, "Parse error"));
		return;
	}
	if (Array.isArray(message)) {
		if (message.length === 0) {
			send(errorResponse(null, -32600, "Invalid Request"));
			return;
		}
		const responses = (
			await Promise.all(message.map((item) => responseFor(item, options)))
		).filter((item) => item !== undefined);
		if (responses.length) send(responses);
		return;
	}
	const response = await responseFor(message, options);
	if (response !== undefined) send(response);
}

async function responseFor(
	message: unknown,
	options: ServerOptions,
): Promise<unknown | undefined> {
	if (!isRequest(message)) {
		return errorResponse(null, -32600, "Invalid Request");
	}
	const id = "id" in message ? message.id : undefined;
	try {
		const result = await dispatch(message, options);
		return id !== undefined ? { jsonrpc: "2.0", id, result } : undefined;
	} catch (error) {
		const rpcError = error instanceof JsonRpcError ? error : undefined;
		if (!rpcError) logDiagnostic(error);
		if (id === undefined) return undefined;
		return errorResponse(
			id,
			rpcError?.code ?? -32603,
			rpcError?.message ?? "Internal error",
		);
	}
}

async function dispatch(
	request: JsonRpcRequest,
	options: ServerOptions,
): Promise<unknown> {
	if (request.method === "initialize") {
		return {
			protocolVersion: "2025-06-18",
			capabilities: { tools: {}, resources: {} },
			serverInfo: { name: "docsnap", version: options.version },
		};
	}
	if (request.method === "notifications/initialized") return {};
	if (request.method === "ping") return {};
	if (request.method === "tools/list") return listTools();
	if (request.method === "tools/call") {
		const params = objectParams(request.params);
		const name = stringParam(params, "name");
		return await callTool(name, params.arguments ?? {}, options.state);
	}
	if (request.method === "resources/list")
		return await listResources(options.state);
	if (request.method === "resources/read") {
		const params = objectParams(request.params);
		try {
			return await readResource(stringParam(params, "uri"), options.state);
		} catch (error) {
			throw new JsonRpcError(-32602, safeErrorMessage(error));
		}
	}
	throw new JsonRpcError(-32601, `Method not found: ${request.method}`);
}

function isRequest(value: unknown): value is JsonRpcRequest {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const input = value as Partial<JsonRpcRequest>;
	if (input.jsonrpc !== "2.0" || typeof input.method !== "string") return false;
	if (
		"id" in input &&
		input.id !== null &&
		typeof input.id !== "string" &&
		typeof input.id !== "number"
	) {
		return false;
	}
	return true;
}

function objectParams(params: unknown): RpcParams {
	if (!params || typeof params !== "object" || Array.isArray(params)) {
		throw new JsonRpcError(-32602, "Invalid params");
	}
	return params as RpcParams;
}

function stringParam(params: Record<string, unknown>, key: string): string {
	const value = params[key];
	if (typeof value !== "string" || value.trim() === "") {
		throw new JsonRpcError(-32602, `Invalid params: ${key} must be a string`);
	}
	return value;
}

function send(message: unknown): void {
	process.stdout.write(`${JSON.stringify(message)}\n`);
}

function errorResponse(id: JsonRpcId, code: number, message: string) {
	return { jsonrpc: "2.0", id, error: { code, message } };
}

function safeErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

class JsonRpcError extends Error {
	constructor(
		readonly code: number,
		message: string,
	) {
		super(message);
	}
}
