import { describe, expect, test } from "bun:test";
import type { LookupAddress } from "node:dns";
import { brotliCompressSync, gzipSync } from "node:zlib";
import { decodeContent, pinnedLookup } from "../src/fetch/transport.ts";

describe("DNS pinning", () => {
	test("returns only the validated address for scalar and all lookups", async () => {
		const lookup = pinnedLookup({ address: "1.1.1.1", family: 4 });
		const scalar = await new Promise<{ address: string; family: number }>(
			(resolve, reject) =>
				lookup("docs.example.com", {}, (error, address, family) => {
					if (error) return reject(error);
					if (family === undefined) return reject(new Error("missing family"));
					if (Array.isArray(address))
						return reject(new Error("unexpected address list"));
					resolve({ address, family });
				}),
		);
		const all = await new Promise<LookupAddress[]>((resolve, reject) =>
			lookup("docs.example.com", { all: true }, (error, addresses) => {
				if (error) return reject(error);
				if (!Array.isArray(addresses))
					return reject(new Error("missing address list"));
				resolve(addresses);
			}),
		);
		expect(scalar).toEqual({ address: "1.1.1.1", family: 4 });
		expect(all).toEqual([{ address: "1.1.1.1", family: 4 }]);
	});

	test("decodes stacked content encodings in reverse order", () => {
		const body = Buffer.from("stacked transport body");
		const encoded = brotliCompressSync(gzipSync(body));
		expect(Buffer.from(decodeContent(encoded, "gzip, br", 1024))).toEqual(body);
	});

	test("rejects a compressed body whose decoded bytes exceed the limit", () => {
		const encoded = gzipSync(Buffer.alloc(4096, "a"));
		expect(() => decodeContent(encoded, "gzip", 64)).toThrow(/64 bytes/);
	});
});
