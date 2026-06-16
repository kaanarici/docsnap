import { parseArgs } from "../src/cli/args.ts";
import { fetchText, setFetchTransportForTest } from "../src/fetch/fetcher.ts";

// A 304 from a redirect target we did NOT send a validator for must not be treated
// as a not-modified reuse — we have no prior version of that target to reuse.
const config = parseArgs(["https://docs.example.com/", "--page"]);
if ("help" in config || "version" in config) throw new Error("bad args");

function resp(status: number, headers: Record<string, string> = {}) {
	return {
		url: "x",
		status,
		headers: {
			get: (name: string) => headers[name.toLowerCase()] ?? null,
			getSetCookie: () => [],
		},
		body: new Uint8Array(),
	};
}

const sent: Array<Record<string, string>> = [];
setFetchTransportForTest(async (input, headers) => {
	sent.push(headers as Record<string, string>);
	return input === "https://docs.example.com/start"
		? resp(302, { location: "https://other.example/target" })
		: resp(304, { etag: '"target"' });
});
const result = await fetchText(
	"https://docs.example.com/start",
	config,
	undefined,
	{ etag: '"start"', urls: ["https://docs.example.com/start"] },
);
setFetchTransportForTest(undefined);

assert(!result.ok);
assert(result.status === 304);
assert(result.finalUrl === "https://other.example/target");
assert(!("notModified" in result) || result.notModified !== true);
// we sent if-none-match for /start but never for the redirect target
assert(sent[0]?.["if-none-match"] === '"start"');
assert(!("if-none-match" in (sent[1] ?? {})));

console.log("conditional-304 regression passed");

function assert(condition: unknown): asserts condition {
	if (!condition) throw new Error("conditional-304 assertion failed");
}
