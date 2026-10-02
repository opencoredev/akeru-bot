import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";

export const decodeJson = Schema.decodeUnknownSync(Schema.Json);

export const decodeJsonString = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json));

export function isJsonObject(value: Schema.Json | undefined): value is Schema.JsonObject {
  return Predicate.isObject(value);
}

export function jsonObject(value: Schema.Json | undefined): Schema.JsonObject | undefined {
  return isJsonObject(value) ? value : undefined;
}
