import type { IncomingHttpHeaders } from "node:http";
import { createServer } from "node:http";

const sandboxNetworkDisabledEnv = "CODEX_SANDBOX_NETWORK_DISABLED";

export type TestServer = {
	origin: string;
	port: number;
	stop(): Promise<void>;
};

export function sandboxNetworkDisabled(): boolean {
	return process.env[sandboxNetworkDisabledEnv] === "1";
}

export function logSandboxNetworkSkip(scope: string): void {
	console.log(
		`skip: ${scope}: CODEX_SANDBOX_NETWORK_DISABLED=1 disables local fixture networking`,
	);
}

export function exitOnSandboxNetworkDisabled(scope: string): void {
	if (!sandboxNetworkDisabled()) return;
	logSandboxNetworkSkip(scope);
	process.exit(0);
}

export async function startLoopbackServer(
	fetch: (request: Request) => Response | Promise<Response>,
): Promise<TestServer> {
	const server = createServer(async (request, response) => {
		const address = server.address();
		if (!address || typeof address === "string") {
			response.writeHead(500);
			response.end("fixture server has no TCP address");
			return;
		}
		const result = await fetch(
			new Request(`http://127.0.0.1:${address.port}${request.url ?? "/"}`, {
				headers: webHeaders(request.headers),
			}),
		);
		response.writeHead(result.status, Object.fromEntries(result.headers));
		response.end(await result.text());
	});
	await listen(server);
	const address = server.address();
	if (!address || typeof address === "string") {
		await close(server);
		throw new Error("fixture server did not bind a TCP port");
	}
	return {
		origin: `http://127.0.0.1:${address.port}`,
		port: address.port,
		stop: () => close(server),
	};
}

function webHeaders(input: IncomingHttpHeaders): Headers {
	const headers = new Headers();
	for (const [key, value] of Object.entries(input)) {
		if (Array.isArray(value)) {
			for (const item of value) headers.append(key, item);
		} else if (value !== undefined) {
			headers.set(key, value);
		}
	}
	return headers;
}

function listen(server: ReturnType<typeof createServer>): Promise<void> {
	return new Promise((resolve, reject) => {
		const onError = (error: Error) => {
			server.off("listening", onListening);
			reject(
				new Error(`failed to start local fixture server: ${error.message}`),
			);
		};
		const onListening = () => {
			server.off("error", onError);
			resolve();
		};
		server.once("error", onError);
		server.once("listening", onListening);
		server.listen(0, "127.0.0.1");
	});
}

function close(server: ReturnType<typeof createServer>): Promise<void> {
	return new Promise((resolve, reject) =>
		server.close((error) => (error ? reject(error) : resolve())),
	);
}
