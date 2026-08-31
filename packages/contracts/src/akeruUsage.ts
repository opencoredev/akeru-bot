import * as Schema from "effect/Schema";

import {
  BotId,
  IsoDateTime,
  NonNegativeInt,
  ThreadId,
  TrimmedNonEmptyString,
  TurnId,
} from "./baseSchemas.ts";
import { ProviderDriverKind } from "./providerInstance.ts";
import { BotUsageCap } from "./orchestration.ts";

export const AkeruUsageReservationId = TrimmedNonEmptyString.pipe(
  Schema.brand("AkeruUsageReservationId"),
);
export type AkeruUsageReservationId = typeof AkeruUsageReservationId.Type;

export const AkeruUsageCategory = Schema.Literals([
  "turn",
  "tool",
  "observer",
  "reflector",
  "extraction",
  "recall",
  "routine",
  "delegated",
]);
export type AkeruUsageCategory = typeof AkeruUsageCategory.Type;

export const AkeruUsageState = Schema.Literals(["reserved", "reported", "unavailable", "released"]);
export type AkeruUsageState = typeof AkeruUsageState.Type;

export const AkeruUsageEntry = Schema.Struct({
  reservationId: AkeruUsageReservationId,
  sourceKey: TrimmedNonEmptyString,
  botId: BotId,
  threadId: Schema.NullOr(ThreadId),
  turnId: Schema.NullOr(TurnId),
  category: AkeruUsageCategory,
  state: AkeruUsageState,
  reservedTokens: NonNegativeInt,
  inputTokens: Schema.NullOr(NonNegativeInt),
  outputTokens: Schema.NullOr(NonNegativeInt),
  reasoningTokens: Schema.NullOr(NonNegativeInt),
  provider: Schema.NullOr(ProviderDriverKind),
  model: Schema.NullOr(TrimmedNonEmptyString),
  unavailableReason: Schema.NullOr(TrimmedNonEmptyString),
  createdAt: IsoDateTime,
  settledAt: Schema.NullOr(IsoDateTime),
});
export type AkeruUsageEntry = typeof AkeruUsageEntry.Type;

export const AkeruBotUsageSummary = Schema.Struct({
  botId: BotId,
  consumedTokens: NonNegativeInt,
  reservedTokens: NonNegativeInt,
  measurements: Schema.Struct({
    input: Schema.Struct({ tokens: NonNegativeInt, unavailableEntries: NonNegativeInt }),
    output: Schema.Struct({ tokens: NonNegativeInt, unavailableEntries: NonNegativeInt }),
    observer: Schema.Struct({ tokens: NonNegativeInt, unavailableEntries: NonNegativeInt }),
    reflector: Schema.Struct({ tokens: NonNegativeInt, unavailableEntries: NonNegativeInt }),
  }),
  entries: Schema.Array(AkeruUsageEntry),
});
export type AkeruBotUsageSummary = typeof AkeruBotUsageSummary.Type;

export const AkeruBotUsageInput = Schema.Struct({ botId: BotId });
export type AkeruBotUsageInput = typeof AkeruBotUsageInput.Type;

export const AkeruBotUsageSnapshot = Schema.Struct({
  ...AkeruBotUsageSummary.fields,
  usageCap: Schema.NullOr(BotUsageCap),
  estimatedCost: Schema.Union([
    Schema.Struct({
      status: Schema.Literal("available"),
      usd: Schema.Number.check(Schema.isFinite(), Schema.isGreaterThanOrEqualTo(0)),
    }),
    Schema.Struct({ status: Schema.Literal("unavailable"), usd: Schema.Null }),
  ]),
  subscriptionPool: Schema.Union([
    Schema.Struct({
      status: Schema.Literal("available"),
      used: NonNegativeInt,
      limit: NonNegativeInt,
      unit: TrimmedNonEmptyString,
    }),
    Schema.Struct({
      status: Schema.Literal("unavailable"),
      used: Schema.Null,
      limit: Schema.Null,
      unit: Schema.Null,
    }),
  ]),
});
export type AkeruBotUsageSnapshot = typeof AkeruBotUsageSnapshot.Type;

export class AkeruBotUsageReadError extends Schema.TaggedErrorClass<AkeruBotUsageReadError>()(
  "AkeruBotUsageReadError",
  { botId: BotId, detail: TrimmedNonEmptyString },
) {}
