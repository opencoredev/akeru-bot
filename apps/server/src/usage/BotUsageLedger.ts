import {
  AkeruBotUsageSummary,
  AkeruUsageEntry,
  type AkeruUsageCategory,
  type AkeruUsageReservationId,
  type BotId,
  type ProviderDriverKind,
  type ThreadId,
  type TurnId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  type PersistenceDecodeError,
  PersistenceSqlError,
  toPersistenceDecodeError,
  toPersistenceSqlError,
} from "../persistence/Errors.ts";

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

type SettleBotUsageDetails =
  | {
      readonly state: "reported";
      readonly inputTokens: number;
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
    readonly outputTokens: number;
    readonly reasoningTokens: number | null;
    readonly provider: ProviderDriverKind | null;
    readonly model: string | null;
    readonly includedInReservation?: boolean;
    readonly createdAt: string;
  }) => Effect.Effect<AkeruUsageEntry, Exclude<BotUsageLedgerError, BotUsageCapExceeded>>;
  readonly summarize: (
    botId: BotId,
  ) => Effect.Effect<AkeruBotUsageSummary, Exclude<BotUsageLedgerError, BotUsageCapExceeded>>;
}

export class BotUsageLedger extends Context.Service<BotUsageLedger, BotUsageLedgerShape>()(
  "akeru-bot/usage/BotUsageLedger",
) {}

const UsageRow = Schema.Struct({
  reservationId: Schema.String,
  sourceKey: Schema.String,
  botId: Schema.String,
  threadId: Schema.NullOr(Schema.String),
  turnId: Schema.NullOr(Schema.String),
  category: Schema.String,
  state: Schema.String,
  reservedTokens: Schema.Number,
  heldTokens: Schema.Number,
  inputTokens: Schema.NullOr(Schema.Number),
  outputTokens: Schema.NullOr(Schema.Number),
  reasoningTokens: Schema.NullOr(Schema.Number),
  provider: Schema.NullOr(Schema.String),
  model: Schema.NullOr(Schema.String),
  unavailableReason: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
  settledAt: Schema.NullOr(Schema.String),
});
type UsageRow = typeof UsageRow.Type;

const entryColumns = (sql: SqlClient.SqlClient) =>
  sql.unsafe(`
  reservation_id AS "reservationId", source_key AS "sourceKey", bot_id AS "botId",
  thread_id AS "threadId", turn_id AS "turnId", category, state,
  reserved_tokens AS "reservedTokens", held_tokens AS "heldTokens",
  input_tokens AS "inputTokens",
  output_tokens AS "outputTokens", reasoning_tokens AS "reasoningTokens",
  provider, model, unavailable_reason AS "unavailableReason",
  created_at AS "createdAt", settled_at AS "settledAt"
`);

const selectEntryByReservation = (sql: SqlClient.SqlClient, reservationId: string) =>
  sql<UsageRow>`
    SELECT ${entryColumns(sql)}
    FROM akeru_bot_usage_entries
    WHERE reservation_id = ${reservationId}
  `;

const selectEntryBySource = (sql: SqlClient.SqlClient, botId: string, sourceKey: string) =>
  sql<UsageRow>`
    SELECT ${entryColumns(sql)}
    FROM akeru_bot_usage_entries
    WHERE bot_id = ${botId} AND source_key = ${sourceKey}
  `;

const selectEntryForTurn = (
  sql: SqlClient.SqlClient,
  botId: string,
  threadId: string,
  turnId: string,
) =>
  sql<UsageRow>`
    SELECT ${entryColumns(sql)}
    FROM akeru_bot_usage_entries
    WHERE bot_id = ${botId}
      AND thread_id = ${threadId}
      AND category = 'turn'
      AND (turn_id = ${turnId} OR (turn_id IS NULL AND state = 'reserved'))
    ORDER BY CASE WHEN turn_id = ${turnId} THEN 0 ELSE 1 END, created_at DESC
    LIMIT 1
  `;

const decodeEntry = (row: UsageRow) =>
  Schema.decodeUnknownEffect(AkeruUsageEntry)(row).pipe(
    Effect.mapError(toPersistenceDecodeError("BotUsageLedger.decodeEntry")),
  );

function validateTokens(operation: string, values: ReadonlyArray<number>) {
  const invalid = values.find((value) => !Number.isSafeInteger(value) || value < 0);
  return invalid === undefined
    ? Effect.void
    : new PersistenceSqlError({
        operation,
        detail: "Token values must be non-negative safe integers.",
      });
}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const writeLock = yield* Semaphore.make(1);

  const settleCurrent = Effect.fn("BotUsageLedger.settleCurrent")(function* (
    current: UsageRow,
    input: SettleBotUsageDetails & { readonly settledAt: string },
    finalizeReported = true,
  ) {
    if (input.state === "reported") {
      yield* validateTokens("BotUsageLedger.settle", [
        input.inputTokens,
        input.outputTokens,
        ...(input.reasoningTokens === null ? [] : [input.reasoningTokens]),
      ]);
    }
    if (current.state === "released" || current.state === "unavailable") {
      return yield* decodeEntry(current);
    }

    const priorReported =
      current.state === "reported" ? (current.inputTokens ?? 0) + (current.outputTokens ?? 0) : 0;
    const nextReported =
      input.state === "reported"
        ? input.inputTokens + input.outputTokens
        : input.state === "unavailable"
          ? current.reservedTokens
          : 0;
    if (
      current.state === "reported" &&
      (input.state !== "reported" || nextReported <= priorReported)
    ) {
      return yield* decodeEntry(current);
    }

    const priorHeld = current.heldTokens;
    const nextHeld =
      input.state === "reported" && !finalizeReported
        ? Math.max(0, priorHeld - (nextReported - priorReported))
        : 0;
    const releasedReservation = priorHeld - nextHeld;
    const priorCharged = priorReported;
    const nextCharged = nextReported;
    const chargedDelta = nextCharged - priorCharged;
    yield* sql`
      UPDATE akeru_bot_usage_balances
      SET reserved_tokens = reserved_tokens - ${releasedReservation},
          consumed_tokens = consumed_tokens + ${chargedDelta},
          updated_at = ${input.settledAt}
      WHERE bot_id = ${current.botId}
    `;
    yield* sql`
      UPDATE akeru_bot_usage_entries SET
        state = ${input.state},
        held_tokens = ${nextHeld},
        input_tokens = ${input.state === "reported" ? input.inputTokens : null},
        output_tokens = ${input.state === "reported" ? input.outputTokens : null},
        reasoning_tokens = ${input.state === "reported" ? input.reasoningTokens : null},
        unavailable_reason = ${input.state === "unavailable" ? input.reason : null},
        settled_at = ${input.settledAt}
      WHERE reservation_id = ${current.reservationId}
    `;
    const settled = yield* selectEntryByReservation(sql, current.reservationId);
    return yield* decodeEntry(settled[0]!);
  });

  const reserve: BotUsageLedgerShape["reserve"] = (input) =>
    writeLock.withPermit(
      sql
        .withTransaction(
          Effect.gen(function* () {
            yield* validateTokens("BotUsageLedger.reserve", [input.maximumTokens, input.capLimit]);
            const prior = yield* selectEntryBySource(sql, input.botId, input.sourceKey);
            if (prior[0]) return yield* decodeEntry(prior[0]);

            yield* sql`
            INSERT INTO akeru_bot_usage_balances (bot_id, consumed_tokens, reserved_tokens, updated_at)
            VALUES (${input.botId}, 0, 0, ${input.createdAt})
            ON CONFLICT (bot_id) DO NOTHING
          `;
            const balance = yield* sql<{
              readonly consumedTokens: number;
              readonly reservedTokens: number;
            }>`
            SELECT consumed_tokens AS "consumedTokens", reserved_tokens AS "reservedTokens"
            FROM akeru_bot_usage_balances WHERE bot_id = ${input.botId}
          `;
            const current = balance[0]!;
            const available = input.capLimit - current.consumedTokens - current.reservedTokens;
            if (input.maximumTokens <= 0 || available <= 0) {
              return yield* new BotUsageCapExceeded({
                botId: input.botId,
                limit: input.capLimit,
                consumedTokens: current.consumedTokens,
                reservedTokens: current.reservedTokens,
                requestedTokens: input.maximumTokens,
              });
            }
            const reservedTokens = Math.min(input.maximumTokens, available);
            yield* sql`
            UPDATE akeru_bot_usage_balances
            SET reserved_tokens = reserved_tokens + ${reservedTokens}, updated_at = ${input.createdAt}
            WHERE bot_id = ${input.botId}
          `;
            yield* sql`
            INSERT INTO akeru_bot_usage_entries (
              reservation_id, source_key, bot_id, thread_id, turn_id, category, state,
              reserved_tokens, held_tokens, input_tokens, output_tokens, reasoning_tokens, provider,
              model, unavailable_reason, created_at, settled_at
            ) VALUES (
              ${input.reservationId}, ${input.sourceKey}, ${input.botId}, ${input.threadId},
              ${input.turnId}, ${input.category}, 'reserved', ${reservedTokens}, ${reservedTokens},
              NULL, NULL, NULL, ${input.provider}, ${input.model}, NULL, ${input.createdAt}, NULL
            )
          `;
            const rows = yield* selectEntryByReservation(sql, input.reservationId);
            return yield* decodeEntry(rows[0]!);
          }),
        )
        .pipe(
          Effect.mapError((cause) =>
            cause._tag === "BotUsageCapExceeded"
              ? cause
              : cause._tag === "PersistenceDecodeError"
                ? cause
                : toPersistenceSqlError("BotUsageLedger.reserve")(cause),
          ),
        ),
    );

  const settle: BotUsageLedgerShape["settle"] = (input) =>
    writeLock.withPermit(
      sql
        .withTransaction(
          Effect.gen(function* () {
            const rows = yield* selectEntryByReservation(sql, input.reservationId);
            const current = rows[0];
            if (!current) {
              return yield* toPersistenceSqlError("BotUsageLedger.settle:not-found")(
                input.reservationId,
              );
            }
            return yield* settleCurrent(current, input);
          }),
        )
        .pipe(
          Effect.mapError((cause) =>
            cause._tag === "PersistenceSqlError" || cause._tag === "PersistenceDecodeError"
              ? cause
              : toPersistenceSqlError("BotUsageLedger.settle")(cause),
          ),
        ),
    );

  const bindTurn: BotUsageLedgerShape["bindTurn"] = (input) =>
    writeLock.withPermit(
      sql
        .withTransaction(
          Effect.gen(function* () {
            const rows = yield* selectEntryByReservation(sql, input.reservationId);
            const current = rows[0];
            if (!current) {
              return yield* new PersistenceSqlError({
                operation: "BotUsageLedger.bindTurn",
                detail: "Usage reservation was not found.",
              });
            }
            if (current.turnId !== null && current.turnId !== input.turnId) {
              return yield* new PersistenceSqlError({
                operation: "BotUsageLedger.bindTurn",
                detail: "Usage reservation is already bound to another turn.",
              });
            }
            if (current.turnId === null) {
              yield* sql`
              UPDATE akeru_bot_usage_entries SET turn_id = ${input.turnId}
              WHERE reservation_id = ${input.reservationId} AND turn_id IS NULL
            `;
            }
            const bound = yield* selectEntryByReservation(sql, input.reservationId);
            return yield* decodeEntry(bound[0]!);
          }),
        )
        .pipe(
          Effect.mapError((cause) =>
            cause._tag === "PersistenceSqlError" || cause._tag === "PersistenceDecodeError"
              ? cause
              : toPersistenceSqlError("BotUsageLedger.bindTurn")(cause),
          ),
        ),
    );

  const settleForTurn: BotUsageLedgerShape["settleForTurn"] = (input) =>
    writeLock.withPermit(
      sql
        .withTransaction(
          Effect.gen(function* () {
            const rows = yield* selectEntryForTurn(sql, input.botId, input.threadId, input.turnId);
            const current = rows[0];
            if (!current) return [];
            if (current.turnId === null) {
              yield* sql`
              UPDATE akeru_bot_usage_entries SET turn_id = ${input.turnId}
              WHERE reservation_id = ${current.reservationId} AND turn_id IS NULL
            `;
            }
            return [yield* settleCurrent({ ...current, turnId: input.turnId }, input, false)];
          }),
        )
        .pipe(
          Effect.mapError((cause) =>
            cause._tag === "PersistenceSqlError" || cause._tag === "PersistenceDecodeError"
              ? cause
              : toPersistenceSqlError("BotUsageLedger.settleForTurn")(cause),
          ),
        ),
    );

  const finalizeForTurn: BotUsageLedgerShape["finalizeForTurn"] = (input) =>
    writeLock.withPermit(
      sql
        .withTransaction(
          Effect.gen(function* () {
            const rows = yield* selectEntryForTurn(sql, input.botId, input.threadId, input.turnId);
            const current = rows[0];
            if (!current) return [];
            if (current.state === "reserved") {
              return [
                yield* settleCurrent(current, {
                  state: "unavailable",
                  reason: "Provider completed without token usage.",
                  settledAt: input.settledAt,
                }),
              ];
            }
            if (current.state !== "reported") return [yield* decodeEntry(current)];
            const held = current.heldTokens;
            if (held > 0) {
              yield* sql`
              UPDATE akeru_bot_usage_balances
              SET reserved_tokens = reserved_tokens - ${held}, updated_at = ${input.settledAt}
              WHERE bot_id = ${current.botId}
            `;
            }
            yield* sql`
            UPDATE akeru_bot_usage_entries
            SET held_tokens = 0, settled_at = ${input.settledAt}
            WHERE reservation_id = ${current.reservationId}
          `;
            const finalized = yield* selectEntryByReservation(sql, current.reservationId);
            return [yield* decodeEntry(finalized[0]!)];
          }),
        )
        .pipe(
          Effect.mapError((cause) =>
            cause._tag === "PersistenceSqlError" || cause._tag === "PersistenceDecodeError"
              ? cause
              : toPersistenceSqlError("BotUsageLedger.finalizeForTurn")(cause),
          ),
        ),
    );

  const recordMeasurement: BotUsageLedgerShape["recordMeasurement"] = (input) =>
    writeLock.withPermit(
      sql
        .withTransaction(
          Effect.gen(function* () {
            yield* validateTokens("BotUsageLedger.recordMeasurement", [
              input.inputTokens,
              input.outputTokens,
              ...(input.reasoningTokens === null ? [] : [input.reasoningTokens]),
            ]);
            const prior = yield* selectEntryBySource(sql, input.botId, input.sourceKey);
            if (prior[0]) return yield* decodeEntry(prior[0]);
            const measuredTokens = input.inputTokens + input.outputTokens;
            if (!input.includedInReservation) {
              yield* sql`
            INSERT INTO akeru_bot_usage_balances (
              bot_id, consumed_tokens, reserved_tokens, updated_at
            ) VALUES (${input.botId}, ${measuredTokens}, 0, ${input.createdAt})
            ON CONFLICT (bot_id) DO UPDATE SET
              consumed_tokens = consumed_tokens + ${measuredTokens},
              updated_at = ${input.createdAt}
          `;
            }
            yield* sql`
          INSERT INTO akeru_bot_usage_entries (
            reservation_id, source_key, bot_id, thread_id, turn_id, category, state,
            reserved_tokens, held_tokens, input_tokens, output_tokens, reasoning_tokens, provider,
            model, unavailable_reason, created_at, settled_at
          ) VALUES (
            ${input.reservationId}, ${input.sourceKey}, ${input.botId}, ${input.threadId},
            ${input.turnId}, ${input.category}, 'reported', 0, 0, ${input.inputTokens},
            ${input.outputTokens}, ${input.reasoningTokens}, ${input.provider}, ${input.model},
            NULL, ${input.createdAt}, ${input.createdAt}
          )
        `;
            const rows = yield* selectEntryByReservation(sql, input.reservationId);
            return yield* decodeEntry(rows[0]!);
          }),
        )
        .pipe(
          Effect.mapError((cause) =>
            cause._tag === "PersistenceSqlError" || cause._tag === "PersistenceDecodeError"
              ? cause
              : toPersistenceSqlError("BotUsageLedger.recordMeasurement")(cause),
          ),
        ),
    );

  const summarize: BotUsageLedgerShape["summarize"] = (botId) =>
    Effect.gen(function* () {
      const balances = yield* sql<{
        readonly consumedTokens: number;
        readonly reservedTokens: number;
      }>`
        SELECT consumed_tokens AS "consumedTokens", reserved_tokens AS "reservedTokens"
        FROM akeru_bot_usage_balances WHERE bot_id = ${botId}
      `;
      const rows = yield* sql<UsageRow>`
        SELECT ${entryColumns(sql)}
        FROM akeru_bot_usage_entries WHERE bot_id = ${botId}
        ORDER BY created_at DESC LIMIT 200
      `;
      const measurements = yield* sql<{
        readonly inputTokens: number;
        readonly outputTokens: number;
        readonly observerTokens: number;
        readonly reflectorTokens: number;
        readonly unavailableCoreEntries: number;
        readonly unavailableObserverEntries: number;
        readonly unavailableReflectorEntries: number;
      }>`
        SELECT
          COALESCE(SUM(CASE WHEN state = 'reported' AND category NOT IN ('observer', 'reflector')
            THEN input_tokens ELSE 0 END), 0) AS "inputTokens",
          COALESCE(SUM(CASE WHEN state = 'reported' AND category NOT IN ('observer', 'reflector')
            THEN output_tokens ELSE 0 END), 0) AS "outputTokens",
          MAX(0,
            COALESCE(SUM(CASE WHEN state = 'reported' AND category = 'observer'
              THEN input_tokens + output_tokens ELSE 0 END), 0)
              - COALESCE(SUM(CASE WHEN state = 'reported' AND category = 'reflector'
                THEN input_tokens + output_tokens ELSE 0 END), 0)
          ) AS "observerTokens",
          COALESCE(SUM(CASE WHEN state = 'reported' AND category = 'reflector'
            THEN input_tokens + output_tokens ELSE 0 END), 0) AS "reflectorTokens",
          COALESCE(SUM(CASE WHEN state = 'unavailable' AND category NOT IN ('observer', 'reflector')
            THEN 1 ELSE 0 END), 0) AS "unavailableCoreEntries",
          COALESCE(SUM(CASE WHEN state = 'unavailable' AND category = 'observer' THEN 1 ELSE 0 END), 0)
            AS "unavailableObserverEntries",
          COALESCE(SUM(CASE WHEN state = 'unavailable' AND category = 'reflector' THEN 1 ELSE 0 END), 0)
            AS "unavailableReflectorEntries"
        FROM akeru_bot_usage_entries WHERE bot_id = ${botId}
      `;
      const entries = yield* Effect.forEach(rows, decodeEntry);
      const totals = measurements[0]!;
      return yield* Schema.decodeUnknownEffect(AkeruBotUsageSummary)({
        botId,
        consumedTokens: balances[0]?.consumedTokens ?? 0,
        reservedTokens: balances[0]?.reservedTokens ?? 0,
        measurements: {
          input: { tokens: totals.inputTokens, unavailableEntries: totals.unavailableCoreEntries },
          output: {
            tokens: totals.outputTokens,
            unavailableEntries: totals.unavailableCoreEntries,
          },
          observer: {
            tokens: totals.observerTokens,
            unavailableEntries: totals.unavailableObserverEntries,
          },
          reflector: {
            tokens: totals.reflectorTokens,
            unavailableEntries: totals.unavailableReflectorEntries,
          },
        },
        entries,
      }).pipe(Effect.mapError(toPersistenceDecodeError("BotUsageLedger.summarize")));
    }).pipe(
      Effect.mapError((cause) =>
        cause._tag === "PersistenceDecodeError"
          ? cause
          : toPersistenceSqlError("BotUsageLedger.summarize")(cause),
      ),
    );

  const reconcileInterruptedReservations = writeLock.withPermit(
    sql
      .withTransaction(
        Effect.gen(function* () {
          const reconciledAt = DateTime.formatIso(yield* DateTime.now);
          const rows = yield* sql<UsageRow>`
        SELECT ${entryColumns(sql)}
        FROM akeru_bot_usage_entries
        WHERE held_tokens > 0
      `;
          for (const row of rows) {
            if (row.state === "reported") {
              yield* sql`
            UPDATE akeru_bot_usage_balances
            SET reserved_tokens = reserved_tokens - ${row.heldTokens}, updated_at = ${reconciledAt}
            WHERE bot_id = ${row.botId}
          `;
              yield* sql`
            UPDATE akeru_bot_usage_entries
            SET held_tokens = 0, settled_at = ${reconciledAt}
            WHERE reservation_id = ${row.reservationId}
          `;
              continue;
            }
            yield* settleCurrent(
              row,
              row.turnId === null
                ? { state: "released", settledAt: reconciledAt }
                : {
                    state: "unavailable",
                    reason: "Provider work was interrupted by a server restart.",
                    settledAt: reconciledAt,
                  },
            );
          }
        }),
      )
      .pipe(
        Effect.mapError(toPersistenceSqlError("BotUsageLedger.reconcileInterruptedReservations")),
      ),
  );

  yield* reconcileInterruptedReservations;

  return {
    reserve,
    settle,
    bindTurn,
    settleForTurn,
    finalizeForTurn,
    recordMeasurement,
    summarize,
  } satisfies BotUsageLedgerShape;
});

export const BotUsageLedgerLive = Layer.effect(BotUsageLedger, make);
