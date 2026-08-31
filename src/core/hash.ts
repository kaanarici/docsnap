export function hashContent(value: string): string {
	return Bun.CryptoHasher.hash("sha256", value, "hex");
}
