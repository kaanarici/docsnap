import { Buffer } from "node:buffer";
import { PassThrough } from "node:stream";
import { CdpConnection } from "../src/render/cdp.ts";

// a CDP frame whose multibyte utf-8 sequences are split across pipe chunks must
// decode intact (StringDecoder buffers partial sequences) — feeding one byte per
// chunk splits every multibyte char, which a per-chunk toString would corrupt
const toBrowser = new PassThrough();
const fromBrowser = new PassThrough();
const cdp = new CdpConnection(toBrowser, fromBrowser);
const id = new Promise<number>((resolve) =>
	toBrowser.once("data", (chunk: Buffer) =>
		resolve(
			(JSON.parse(chunk.toString("utf8").slice(0, -1)) as { id: number }).id,
		),
	),
);
const pending = cdp.send<{ product: string }>("Browser.getVersion");
const product = "café 日本語 🚀 résumé ☕ — naïve";
const frame = Buffer.from(
	`${JSON.stringify({ id: await id, result: { product } })}\0`,
	"utf8",
);
for (const byte of frame) fromBrowser.write(Buffer.from([byte]));
const result = await pending;
assert(result.product === product);
cdp.close();

function assert(condition: unknown): asserts condition {
	if (!condition) throw new Error("assertion failed");
}
