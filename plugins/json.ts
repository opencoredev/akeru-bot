/** JSON values accepted by the dependency-free catalog and marketing parsers. */
export type JsonValue = string | number | boolean | null | undefined | JsonValue[] | JsonObject;

export interface JsonObject {
  [key: string]: JsonValue;
}

export function isJsonString(value: unknown): value is string {
  return typeof value === "string";
}

export function isJsonNumber(value: unknown): value is number {
  return typeof value === "number";
}

export function isJsonBoolean(value: unknown): value is boolean {
  return typeof value === "boolean";
}

export function isJsonValue(value: unknown): value is JsonValue {
  return (
    value == null ||
    isJsonString(value) ||
    isJsonNumber(value) ||
    isJsonBoolean(value) ||
    (Array.isArray(value) ? value.every(isJsonValue) : isJsonObject(value))
  );
}

export function isJsonObject(value: unknown): value is JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;

  return Object.values(value).every(isJsonValue);
}
