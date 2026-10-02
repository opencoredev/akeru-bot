import { decodeJsonString, jsonObject } from "../json.ts";
import * as Predicate from "effect/Predicate";
import { USAGE_3H_COUNTER_MAX, Usage3hEvent } from "@akeru/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export const MAX_PENDING_BUCKETS = 256;

export const AnalyticsState = Schema.Struct({
  version: Schema.Literal(1),
  installationId: Schema.String.check(Schema.isUUID()),
  cursorBucketStart: Schema.String.check(
    Schema.isPattern(/^\d{4}-\d{2}-\d{2}T(?:00|03|06|09|12|15|18|21):00:00\.000Z$/),
  ),
  deliveryDay: Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/)),
  deliveredToday: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 8 })),
  firstActiveInstallReported: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  pending: Schema.Array(Usage3hEvent).check(Schema.isMaxLength(MAX_PENDING_BUCKETS)),
});

export type AnalyticsState = typeof AnalyticsState.Type;

export const decodeState = Schema.decodeUnknownSync(Schema.fromJsonString(AnalyticsState), {
  onExcessProperty: "error",
});

export const encodeState = Schema.encodeSync(Schema.fromJsonString(AnalyticsState));

export const RETIRED_PROVIDER_COUNTERS = [
  ["provider_turns_cursor", "provider_turns_other"],
  ["browser_searches_cursor", "browser_searches_other"],
] as const;

// Folds counters for retired providers into `other` so events queued before an
// upgrade still decode and deliver.
export const migrateLegacyState = (encoded: string): string => {
  const state = decodeJsonString(encoded);

  const root = jsonObject(state);

  if (!root) return encoded;

  if (!Array.isArray(root.pending)) return encoded;

  const pending = root.pending.map((event) => {
    const item = jsonObject(event);
    const properties = jsonObject(item?.properties);

    if (!item || !properties) return event;
    const record = { ...properties };

    for (const [retired, other] of RETIRED_PROVIDER_COUNTERS) {
      const count = record[retired];

      if (count === undefined) continue;
      delete record[retired];

      if (Predicate.isNumber(count) && Predicate.isNumber(record[other])) {
        record[other] = Math.min(record[other] + count, USAGE_3H_COUNTER_MAX);
      }
    }

    if (record.provider === "cursor") record.provider = "other";

    return { ...item, properties: record };
  });

  return JSON.stringify({ ...root, pending });
};

export const encodeJson = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
