import {
  AkeruBotUsageSummary,
  AkeruUsageEntry,
  type AkeruUsageCategory,
  type AkeruUsageReservationId,
  type BotId,
  type ProviderDriverKind,
  type ThreadId,
  type TurnId,
} from "@akeru/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { type PersistenceDecodeError, PersistenceSqlError } from "../persistence/Errors.ts";

export class BotUsageCapExceeded extends Schema.TaggedErrorClass<BotUsageCapExceeded>()(
  "BotUsageCapExceeded",
  {
    botId: Schema.String,
    limit: Schema.Number,
    consumedTokens: Schema.Number,
    reservedTokens: Schema.Number,
    requestedTokens: Schema.Number,
  },
) {
  override get message(): string {
    return `Bot ${this.botId} reached its ${this.limit}-token usage cap.`;
  }
}

export const AKERU_TURN_USAGE_RESERVATION_TOKENS = 32_000;

export interface ReserveBotUsageInput {
  readonly reservationId: AkeruUsageReservationId;
  readonly sourceKey: string;
  readonly botId: BotId;
  readonly threadId: ThreadId | null;
  readonly turnId: TurnId | null;
  readonly category: AkeruUsageCategory;
  readonly maximumTokens: number;
  readonly capLimit: number;
  readonly provider: ProviderDriverKind | null;
  readonly model: string | null;
  readonly createdAt: string;
}

export type SettleBotUsageDetails =
  | {
      readonly state: "reported";
      readonly inputTokens: number;
      readonly cachedInputTokens?: number;
      readonly cacheCreationTokens?: number;
      readonly outputTokens: number;
      readonly reasoningTokens: number | null;
    }
  | { readonly state: "unavailable"; readonly reason: string }
  | { readonly state: "released" };

export type SettleBotUsageInput = SettleBotUsageDetails & {
  readonly reservationId: AkeruUsageReservationId;
  readonly settledAt: string;
};

export type SettleBotUsageForTurnInput = SettleBotUsageDetails & {
  readonly botId: BotId;
  readonly threadId: ThreadId;
  readonly turnId: TurnId;
  readonly settledAt: string;
};

export type BotUsageLedgerError =
  | BotUsageCapExceeded
  | PersistenceSqlError
  | PersistenceDecodeError;

export interface BotUsageLedgerShape {
  readonly pricingTotals: (botId: BotId) => Effect.Effect<
    {
      readonly complete: boolean;
      readonly models: ReadonlyArray<{
        readonly model: string;
        readonly inputTokens: number;
        readonly cachedInputTokens: number;
        readonly cacheCreationTokens: number;
        readonly outputTokens: number;
        readonly reasoningTokens: number;
      }>;
    },
    Exclude<BotUsageLedgerError, BotUsageCapExceeded>
  >;
  readonly reserve: (
    input: ReserveBotUsageInput,
  ) => Effect.Effect<AkeruUsageEntry, BotUsageLedgerError>;
  readonly settle: (
    input: SettleBotUsageInput,
  ) => Effect.Effect<AkeruUsageEntry, Exclude<BotUsageLedgerError, BotUsageCapExceeded>>;
  readonly bindTurn: (input: {
    readonly reservationId: AkeruUsageReservationId;
    readonly turnId: TurnId;
  }) => Effect.Effect<AkeruUsageEntry, Exclude<BotUsageLedgerError, BotUsageCapExceeded>>;
  readonly settleForTurn: (
    input: SettleBotUsageForTurnInput,
  ) => Effect.Effect<
    ReadonlyArray<AkeruUsageEntry>,
    Exclude<BotUsageLedgerError, BotUsageCapExceeded>
  >;
  readonly finalizeForTurn: (input: {
    readonly botId: BotId;
    readonly threadId: ThreadId;
    readonly turnId: TurnId;
    readonly settledAt: string;
    readonly cancelled?: boolean;
  }) => Effect.Effect<
    ReadonlyArray<AkeruUsageEntry>,
    Exclude<BotUsageLedgerError, BotUsageCapExceeded>
  >;
  readonly recordMeasurement: (input: {
    readonly reservationId: AkeruUsageReservationId;
    readonly sourceKey: string;
    readonly botId: BotId;
    readonly threadId: ThreadId | null;
    readonly turnId: TurnId | null;
    readonly category: AkeruUsageCategory;
    readonly inputTokens: number;
    readonly cachedInputTokens?: number;
    readonly cacheCreationTokens?: number;
    readonly outputTokens: number;
    readonly reasoningTokens: number | null;
    readonly provider: ProviderDriverKind | null;
    readonly model: string | null;
    readonly includedInReservation?: boolean;
    readonly createdAt: string;
  }) => Effect.Effect<AkeruUsageEntry, Exclude<BotUsageLedgerError, BotUsageCapExceeded>>;
  /** Records work that charges no tokens so a restart before it settles marks it interrupted. */
  readonly recordStart: (
    input: Omit<ReserveBotUsageInput, "maximumTokens" | "capLimit">,
  ) => Effect.Effect<AkeruUsageEntry, Exclude<BotUsageLedgerError, BotUsageCapExceeded>>;
  readonly summarize: (
    botId: BotId,
  ) => Effect.Effect<AkeruBotUsageSummary, Exclude<BotUsageLedgerError, BotUsageCapExceeded>>;
}
