import { AkeruUsageEntry } from "@akeru/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { PersistenceSqlError, toPersistenceDecodeError } from "../persistence/Errors.ts";

export const UsageRow = Schema.Struct({
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
  cachedInputTokens: Schema.Number,
  cacheCreationTokens: Schema.Number,
  outputTokens: Schema.NullOr(Schema.Number),
  reasoningTokens: Schema.NullOr(Schema.Number),
  provider: Schema.NullOr(Schema.String),
  model: Schema.NullOr(Schema.String),
  unavailableReason: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
  settledAt: Schema.NullOr(Schema.String),
});

export type UsageRow = typeof UsageRow.Type;

export const entryColumns = (sql: SqlClient.SqlClient) =>
  sql.unsafe(`
  reservation_id AS "reservationId", source_key AS "sourceKey", bot_id AS "botId",
  thread_id AS "threadId", turn_id AS "turnId", category, state,
  reserved_tokens AS "reservedTokens", held_tokens AS "heldTokens",
  input_tokens AS "inputTokens",
  cached_input_tokens AS "cachedInputTokens", cache_creation_tokens AS "cacheCreationTokens",
  output_tokens AS "outputTokens", reasoning_tokens AS "reasoningTokens",
  provider, model, unavailable_reason AS "unavailableReason",
  created_at AS "createdAt", settled_at AS "settledAt"
`);

export const selectEntryByReservation = (sql: SqlClient.SqlClient, reservationId: string) =>
  sql<UsageRow>`
    SELECT ${entryColumns(sql)}
    FROM akeru_bot_usage_entries
    WHERE reservation_id = ${reservationId}
  `;

export const selectEntryBySource = (sql: SqlClient.SqlClient, botId: string, sourceKey: string) =>
  sql<UsageRow>`
    SELECT ${entryColumns(sql)}
    FROM akeru_bot_usage_entries
    WHERE bot_id = ${botId} AND source_key = ${sourceKey}
  `;

export const selectEntryForTurn = (
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

export const decodeEntry = (row: UsageRow) =>
  Schema.decodeUnknownEffect(AkeruUsageEntry)(row).pipe(
    Effect.mapError(toPersistenceDecodeError("BotUsageLedger.decodeEntry")),
  );

export function validateTokens(operation: string, values: ReadonlyArray<number>) {
  const invalid = values.find((value) => !Number.isSafeInteger(value) || value < 0);

  return invalid === undefined
    ? Effect.void
    : new PersistenceSqlError({
        operation,
        detail: "Token values must be non-negative safe integers.",
      });
}
