import type { FetchTransport, PipelineConfig } from "../core/types.ts";
import { requestPublicHttp } from "./transport.ts";

// The transport a run actually uses is resolved per request from its config, not
// read from a mutable global at fetch time. config.transport, when set, is that
// value; otherwise the run falls back to the process default below.
//
// In production the default is always requestPublicHttp and nothing ever
// reassigns it, so effectiveTransport is a pure function of config. The default
// holder exists purely so tests can install one mock transport that every run
// built afterward inherits — including runs the CLI builds internally — without
// threading a transport through every call site or mutating any per-request
// state.
let defaultTransport: FetchTransport = requestPublicHttp;

export function effectiveTransport(config: PipelineConfig): FetchTransport {
	return config.transport ?? defaultTransport;
}

export function setFetchTransportForTest(
	transport: FetchTransport | undefined,
): void {
	defaultTransport = transport ?? requestPublicHttp;
}
