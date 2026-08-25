export const snapshotSchemaVersion = 1;

type SnapshotFile = {
	path: string;
	body: string;
};

export type SnapshotLeaf = {
	hash: string;
	bytes: number;
};

export type SnapshotStats = {
	rootHash: string;
	files: number;
	bytes: number;
};

export function byteLength(value: string): number {
	return Buffer.byteLength(value);
}

export function hashContent(value: string): string {
	return Bun.CryptoHasher.hash("sha256", value, "hex");
}

export function snapshotStats(files: SnapshotFile[]): SnapshotStats {
	return snapshotStatsFromLeaves(
		files.map((file) => snapshotLeaf(file.path, file.body)),
	);
}

export function snapshotLeaf(
	path: string,
	body: string,
	contentHash = hashContent(body),
): SnapshotLeaf {
	return {
		hash: hashParts("leaf", path, contentHash),
		bytes: byteLength(body),
	};
}

export function snapshotStatsFromLeaves(
	leaves: readonly SnapshotLeaf[],
): SnapshotStats {
	const bytes = leaves.reduce((total, leaf) => total + leaf.bytes, 0);
	let level = leaves.map((leaf) => leaf.hash).sort();

	if (level.length === 0)
		return { rootHash: hashParts("root"), files: 0, bytes: 0 };

	while (level.length > 1) {
		const next: string[] = [];
		for (let i = 0; i < level.length; i += 2) {
			next.push(hashParts("node", level[i]!, level[i + 1] ?? level[i]!));
		}
		level = next;
	}

	return {
		rootHash: hashParts("root", level[0]!),
		files: leaves.length,
		bytes,
	};
}

function hashParts(...parts: string[]): string {
	const hash = new Bun.CryptoHasher("sha256");
	for (const part of parts) {
		hash.update(part);
		hash.update("\0");
	}
	return hash.digest("hex");
}
