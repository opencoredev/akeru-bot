import * as Predicate from "effect/Predicate";
import { AkeruBotUsageSummary } from "@akeru/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import {
  PersistenceSqlError,
  toPersistenceDecodeError,
  toPersistenceSqlError,
} from "../persistence/Errors.ts";
import {
  BotUsageCapExceeded,
  type SettleBotUsageDetails,
  type BotUsageLedgerShape,
} from "./BotUsageLedgerTypes.ts";
import {
  UsageRow,
  entryColumns,
  selectEntryByReservation,
  selectEntryBySource,
  selectEntryForTurn,
  decodeEntry,
  validateTokens,
} from "./BotUsageRows.ts";

export class BotUsageLedger extends Context.Service<BotUsageLedger, BotUsageLedgerShape>()(
  "akeru-bot/usage/BotUsageLedger",
) {}

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
        input.cachedInputTokens ?? 0,
        input.cacheCreationTokens ?? 0,
        input.outputTokens,
        ...(input.reasoningTokens === null ? [] : [input.reasoningTokens]),
      ]);

      if ((input.cachedInputTokens ?? 0) + (input.cacheCreationTokens ?? 0) > input.inputTokens) {
        return yield* new PersistenceSqlError({
          operation: "BotUsageLedger.settle",
          detail: "Cache tokens cannot exceed total input tokens.",
        });
      }
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

    if (current.state === "reported") {
      if (input.state !== "reported" || nextReported < priorReported) {
        return yield* decodeEntry(current);
      }

      if (nextReported === priorReported) {
        if (
          input.inputTokens === current.inputTokens &&
          input.outputTokens === current.outputTokens
        ) {
          const completeBreakdown =
            input.cachedInputTokens !== undefined && input.cacheCreationTokens !== undefined;

          const cachedInputTokens = completeBreakdown
            ? input.cachedInputTokens!
            : Math.max(current.cachedInputTokens, input.cachedInputTokens ?? 0);

          const cacheCreationTokens = completeBreakdown
            ? input.cacheCreationTokens!
            : Math.max(current.cacheCreationTokens, input.cacheCreationTokens ?? 0);

          if (
            (!current.settledAt || input.settledAt > current.settledAt) &&
            cachedInputTokens + cacheCreationTokens <= input.inputTokens &&
            (cachedInputTokens !== current.cachedInputTokens ||
              cacheCreationTokens !== current.cacheCreationTokens)
          ) {
            yield* sql`
              UPDATE akeru_bot_usage_entries
              SET cached_input_tokens = ${cachedInputTokens},
                  cache_creation_tokens = ${cacheCreationTokens},
                  settled_at = ${input.settledAt}
              WHERE reservation_id = ${current.reservationId}
            `;
            const updated = yield* selectEntryByReservation(sql, current.reservationId);

            return yield* decodeEntry(updated[0]!);
          }
        }

        return yield* decodeEntry(current);
      }
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
        cached_input_tokens = ${input.state === "reported" ? (input.cachedInputTokens ?? 0) : 0},
        cache_creation_tokens = ${input.state === "reported" ? (input.cacheCreationTokens ?? 0) : 0},
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
            Predicate.isTagged(cause, "BotUsageCapExceeded")
              ? cause
              : Predicate.isTagged(cause, "PersistenceDecodeError")
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
            Predicate.isTagged(cause, "PersistenceSqlError") ||
            Predicate.isTagged(cause, "PersistenceDecodeError")
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
            Predicate.isTagged(cause, "PersistenceSqlError") ||
            Predicate.isTagged(cause, "PersistenceDecodeError")
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
            Predicate.isTagged(cause, "PersistenceSqlError") ||
            Predicate.isTagged(cause, "PersistenceDecodeError")
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

            if (current.turnId === null) {
              yield* sql`
                UPDATE akeru_bot_usage_entries SET turn_id = ${input.turnId}
                WHERE reservation_id = ${current.reservationId} AND turn_id IS NULL
              `;
            }

            if (input.cancelled) {
              if (current.heldTokens > 0) {
                yield* sql`
                  UPDATE akeru_bot_usage_balances
                  SET reserved_tokens = reserved_tokens - ${current.heldTokens},
                      updated_at = ${input.settledAt}
                  WHERE bot_id = ${current.botId}
                `;
              }

              if (current.state === "reported") {
                yield* sql`
                  UPDATE akeru_bot_usage_entries
                  SET held_tokens = 0, settled_at = ${input.settledAt}
                  WHERE reservation_id = ${current.reservationId}
                `;
              } else {
                yield* sql`
                  UPDATE akeru_bot_usage_entries
                  SET state = 'released', held_tokens = 0,
              input_tokens = NULL, output_tokens = NULL, reasoning_tokens = NULL,
              cached_input_tokens = 0, cache_creation_tokens = 0,
                      unavailable_reason = NULL, settled_at = ${input.settledAt}
                  WHERE reservation_id = ${current.reservationId}
                `;
              }

              const released = yield* selectEntryByReservation(sql, current.reservationId);

              return [yield* decodeEntry(released[0]!)];
            }

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
            Predicate.isTagged(cause, "PersistenceSqlError") ||
            Predicate.isTagged(cause, "PersistenceDecodeError")
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
              input.cachedInputTokens ?? 0,
              input.cacheCreationTokens ?? 0,
              input.outputTokens,
              ...(input.reasoningTokens === null ? [] : [input.reasoningTokens]),
            ]);

            if (
              (input.cachedInputTokens ?? 0) + (input.cacheCreationTokens ?? 0) >
              input.inputTokens
            ) {
              return yield* new PersistenceSqlError({
                operation: "BotUsageLedger.recordMeasurement",
                detail: "Cache tokens cannot exceed total input tokens.",
              });
            }

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
            reserved_tokens, held_tokens, input_tokens, cached_input_tokens, cache_creation_tokens,
            output_tokens, reasoning_tokens, provider,
            model, unavailable_reason, created_at, settled_at
          ) VALUES (
            ${input.reservationId}, ${input.sourceKey}, ${input.botId}, ${input.threadId},
            ${input.turnId}, ${input.category}, 'reported', 0, 0, ${input.inputTokens},
            ${input.cachedInputTokens ?? 0}, ${input.cacheCreationTokens ?? 0},
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
            Predicate.isTagged(cause, "PersistenceSqlError") ||
            Predicate.isTagged(cause, "PersistenceDecodeError")
              ? cause
              : toPersistenceSqlError("BotUsageLedger.recordMeasurement")(cause),
          ),
        ),
    );

  const recordStart: BotUsageLedgerShape["recordStart"] = (input) =>
    writeLock.withPermit(
      sql
        .withTransaction(
          Effect.gen(function* () {
            const prior = yield* selectEntryBySource(sql, input.botId, input.sourceKey);

            if (prior[0]) return yield* decodeEntry(prior[0]);
            yield* sql`
          INSERT INTO akeru_bot_usage_entries (
            reservation_id, source_key, bot_id, thread_id, turn_id, category, state,
            reserved_tokens, held_tokens, input_tokens, output_tokens, reasoning_tokens, provider,
            model, unavailable_reason, created_at, settled_at
          ) VALUES (
            ${input.reservationId}, ${input.sourceKey}, ${input.botId}, ${input.threadId},
            ${input.turnId}, ${input.category}, 'reserved', 0, 0, NULL, NULL, NULL,
            ${input.provider}, ${input.model}, NULL, ${input.createdAt}, NULL
          )
        `;
            const rows = yield* selectEntryByReservation(sql, input.reservationId);

            return yield* decodeEntry(rows[0]!);
          }),
        )
        .pipe(
          Effect.mapError((cause) =>
            Predicate.isTagged(cause, "PersistenceDecodeError")
              ? cause
              : toPersistenceSqlError("BotUsageLedger.recordStart")(cause),
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
        readonly cachedInputTokens: number;
        readonly cacheCreationTokens: number;
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
          COALESCE(SUM(CASE WHEN state = 'unavailable' AND reserved_tokens > 0
            AND category NOT IN ('observer', 'reflector') THEN 1 ELSE 0 END), 0)
            AS "unavailableCoreEntries",
          COALESCE(SUM(CASE WHEN state = 'unavailable' AND reserved_tokens > 0
            AND category = 'observer' THEN 1 ELSE 0 END), 0) AS "unavailableObserverEntries",
          COALESCE(SUM(CASE WHEN state = 'unavailable' AND reserved_tokens > 0
            AND category = 'reflector' THEN 1 ELSE 0 END), 0) AS "unavailableReflectorEntries"
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
        Predicate.isTagged(cause, "PersistenceDecodeError")
          ? cause
          : toPersistenceSqlError("BotUsageLedger.summarize")(cause),
      ),
    );

  const pricingTotals: BotUsageLedgerShape["pricingTotals"] = (botId) =>
    Effect.gen(function* () {
      const rows = yield* sql<{
        readonly model: string | null;
        readonly inputTokens: number;
        readonly cachedInputTokens: number;
        readonly cacheCreationTokens: number;
        readonly outputTokens: number;
        readonly reasoningTokens: number;
        readonly incompleteEntries: number;
      }>`
        SELECT model,
          COALESCE(SUM(CASE WHEN state = 'reported' THEN input_tokens ELSE 0 END), 0) AS "inputTokens",
          COALESCE(SUM(CASE WHEN state = 'reported' THEN cached_input_tokens ELSE 0 END), 0) AS "cachedInputTokens",
          COALESCE(SUM(CASE WHEN state = 'reported' THEN cache_creation_tokens ELSE 0 END), 0) AS "cacheCreationTokens",
          COALESCE(SUM(CASE WHEN state = 'reported' THEN output_tokens ELSE 0 END), 0) AS "outputTokens",
          COALESCE(SUM(CASE WHEN state = 'reported' THEN reasoning_tokens ELSE 0 END), 0) AS "reasoningTokens",
          COALESCE(SUM(CASE WHEN (state = 'unavailable' AND reserved_tokens > 0) OR
            (state = 'reported' AND (input_tokens IS NULL OR output_tokens IS NULL))
            THEN 1 ELSE 0 END), 0) AS "incompleteEntries"
        FROM akeru_bot_usage_entries WHERE bot_id = ${botId}
        GROUP BY model
      `;

      return {
        complete: rows.every(
          (row) =>
            row.incompleteEntries === 0 &&
            (row.model !== null || row.inputTokens + row.outputTokens === 0),
        ),
        models: rows.flatMap((row) =>
          row.model !== null && row.inputTokens + row.outputTokens > 0
            ? [
                {
                  model: row.model,
                  inputTokens: row.inputTokens,
                  cachedInputTokens: row.cachedInputTokens,
                  cacheCreationTokens: row.cacheCreationTokens,
                  outputTokens: row.outputTokens,
                  reasoningTokens: row.reasoningTokens,
                },
              ]
            : [],
        ),
      };
    }).pipe(Effect.mapError(toPersistenceSqlError("BotUsageLedger.pricingTotals")));

  const reconcileInterruptedReservations = writeLock.withPermit(
    sql
      .withTransaction(
        Effect.gen(function* () {
          const reconciledAt = DateTime.formatIso(yield* DateTime.now);

          const rows = yield* sql<UsageRow>`
        SELECT ${entryColumns(sql)}
        FROM akeru_bot_usage_entries
        WHERE held_tokens > 0 OR state = 'reserved'
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
    recordStart,
    summarize,
    pricingTotals,
  } satisfies BotUsageLedgerShape;
});

export const BotUsageLedgerLive = Layer.effect(BotUsageLedger, make);

export { BotUsageCapExceeded } from "./BotUsageLedgerTypes.ts";

export { AKERU_TURN_USAGE_RESERVATION_TOKENS } from "./BotUsageLedgerTypes.ts";

export type { ReserveBotUsageInput } from "./BotUsageLedgerTypes.ts";

export type { SettleBotUsageInput } from "./BotUsageLedgerTypes.ts";

export type { SettleBotUsageForTurnInput } from "./BotUsageLedgerTypes.ts";

export type { BotUsageLedgerError } from "./BotUsageLedgerTypes.ts";

export type { BotUsageLedgerShape } from "./BotUsageLedgerTypes.ts";
