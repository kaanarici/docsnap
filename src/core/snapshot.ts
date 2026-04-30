import { createHash } from "node:crypto";
export const SNAPSHOT_VERSION = 1;

export type SnapshotFile = {
	path: string;
	body: string;
};

export type SnapshotStats = {
	rootHash: string;
	files: number;
	bytes: number;
};

const encoder = new TextEncoder();

export function byteLength(value: string): number {
	return encoder.encode(value).byteLength;
}

export function hashContent(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

export function snapshotStats(files: SnapshotFile[]): SnapshotStats {
	let bytes = 0;
	let level = files
		.map((file) => {
			bytes += byteLength(file.body);
			return hashParts("leaf", file.path, hashContent(file.body));
		})
		.sort();

	if (level.length === 0)
		return { rootHash: hashParts("root"), files: 0, bytes: 0 };

	while (level.length > 1) {
		const next: string[] = [];
		for (let i = 0; i < level.length; i += 2) {
			next.push(hashParts("node", level[i]!, level[i + 1] ?? level[i]!));
		}
		level = next;
	}

	return { rootHash: hashParts("root", level[0]!), files: files.length, bytes };
}

function hashParts(...parts: string[]): string {
	const hash = createHash("sha256");
	for (const part of parts) {
		hash.update(part);
		hash.update("\0");
	}
	return hash.digest("hex");
}
