import type { OrchestrationThreadActivity } from "@akeru/contracts";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";

const decodePayload = Schema.decodeUnknownOption(Schema.Record(Schema.String, Schema.Json));

const payloadByActivity = new WeakMap<OrchestrationThreadActivity, Schema.JsonObject | null>();

/** Activities are immutable; decode each payload once across the work-log projections. */
export function readWorkLogPayload(activity: OrchestrationThreadActivity) {
  const cached = payloadByActivity.get(activity);

  if (cached !== undefined) return cached;
  const payload = Option.getOrNull(decodePayload(activity.payload));
  payloadByActivity.set(activity, payload);

  return payload;
}

function isRecord(value: Schema.Json | undefined): value is Schema.JsonObject {
  return Predicate.isObject(value);
}

export function asRecord(value: Schema.Json | undefined): Schema.JsonObject | null {
  return isRecord(value) ? value : null;
}
