import * as Predicate from "effect/Predicate";
import { flow } from "effect/Function";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

// Provider wire payloads and persisted cursors contain JSON. Decode at the
// adapter boundary before inspecting fields in protocol-specific helpers.
export const readProtocolJson = flow(
  Schema.decodeUnknownOption(Schema.Json),
  Option.getOrUndefined,
);

export const readProtocolRecord = flow(
  Schema.decodeUnknownOption(Schema.Record(Schema.String, Schema.Json)),
  Option.getOrUndefined,
);

export const isProtocolRecord = Schema.is(Schema.Record(Schema.String, Schema.Json));

export const isInspectionRecord = Predicate.isObject;

// SDK objects may carry undefined or opaque properties. Inspect consumed fields
// independently instead of requiring the entire object to be JSON.
export const isSdkRecord = Predicate.isObject;

export function readSdkRecord<Input>(input: Input): SdkRecord | undefined {
  return isSdkRecord(input) ? input : undefined;
}

export type SdkRecord = Pick<Predicate.Refinement.Out<typeof Predicate.isObject>, string>;
