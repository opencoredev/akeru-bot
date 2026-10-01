/** JSON values accepted by the dependency-free catalog and marketing parsers. */
export type JsonValue = string | number | boolean | null | undefined | JsonValue[] | JsonObject;

export interface JsonObject {
  [key: string]: JsonValue;
}

export function isJsonString(value: unknown): value is string {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- The catalog and marketing bundles have no Effect dependency; this is their primitive JSON parser guard.
  return typeof value === "string";
}

export function isJsonNumber(value: unknown): value is number {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- The dependency-free JSON parser must distinguish numbers before passing them to manifest validators.
  return typeof value === "number";
}

export function isJsonBoolean(value: unknown): value is boolean {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- This primitive guard serves the dependency-free JSON parser shared by the catalog and marketing bundles.
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
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- This dependency-free JSON boundary distinguishes objects from functions before traversing their values.
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;

  return Object.values(value).every(isJsonValue);
}
