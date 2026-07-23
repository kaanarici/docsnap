import { describe, expect, test } from "bun:test";
import { pinnedLookup } from "../src/fetch/transport.ts";

describe("DNS pinning", () => {
	test("returns only the validated address for scalar and all lookups", async () => {
		const lookup = pinnedLookup({ address: "1.1.1.1", family: 4 }) as (
			host: string,
			options: unknown,
			callback: (error: Error | null, value: unknown, family?: number) => void,
		) => void;
		const scalar = await new Promise<{ address: unknown; family: number }>(
			(resolve, reject) =>
				lookup("docs.example.com", {}, (error, address, family) => {
					if (error) return reject(error);
					if (family === undefined) return reject(new Error("missing family"));
					resolve({ address, family });
				}),
		);
		const all = await new Promise<unknown>((resolve, reject) =>
			lookup("docs.example.com", { all: true }, (error, addresses) =>
				error ? reject(error) : resolve(addresses),
			),
		);
		expect(scalar).toEqual({ address: "1.1.1.1", family: 4 });
		expect(all).toEqual([{ address: "1.1.1.1", family: 4 }]);
	});
});
