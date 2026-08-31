export type JsonValue =
	| null
	| boolean
	| number
	| string
	| JsonValue[]
	| { [key: string]: JsonValue };

export type JsonObject = { [key: string]: JsonValue };

export function parseJsonValue(text: string): JsonValue {
	return JSON.parse(text);
}

export function isJsonObject(
	value: JsonValue | undefined,
): value is JsonObject {
	return (
		value !== null &&
		value !== undefined &&
		typeof value === "object" &&
		!Array.isArray(value)
	);
}

export function isJsonString(value: JsonValue | undefined): value is string {
	return typeof value === "string";
}

export function isJsonNumber(value: JsonValue | undefined): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

export function isJsonBoolean(value: JsonValue | undefined): value is boolean {
	return typeof value === "boolean";
}

export function jsonEnum<T extends string>(
	value: JsonValue | undefined,
	allowed: readonly T[],
): T | undefined {
	return isJsonString(value)
		? allowed.find((entry) => entry === value)
		: undefined;
}
