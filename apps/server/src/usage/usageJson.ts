import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";

export const decodeUsageJson = Schema.decodeUnknownSync(Schema.Json);

export const decodeUsageJsonLine = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json));

/** Narrows an already decoded JSON value without revalidating its children. */
export function isUsageJsonObject(value: Schema.Json | undefined): value is Schema.JsonObject {
  return Predicate.isObject(value);
}
