import { AkeruUsageEntry } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  type PersistenceDecodeError,
  PersistenceSqlError,
  toPersistenceDecodeError,
  toPersistenceSqlError,
} from "../persistence/Errors.ts";

export interface ProviderUsageWindow {
  readonly sinceAt: string;
  readonly untilAt: string;
}

export class ProviderUsageHistory extends Context.Service<
  ProviderUsageHistory,
  {
    readonly readReported: (
      window: ProviderUsageWindow,
    ) => Effect.Effect<
      ReadonlyArray<AkeruUsageEntry>,
      PersistenceSqlError | PersistenceDecodeError
    >;
  }
>()("akeru-bot/usage/ProviderUsageHistory") {}

const UsageRow = Schema.Struct({
  reservationId: Schema.String,
  sourceKey: Schema.String,
  botId: Schema.String,
  threadId: Schema.NullOr(Schema.String),
  turnId: Schema.NullOr(Schema.String),
  category: Schema.String,
  state: Schema.String,
  reservedTokens: Schema.Number,
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
const decodeUsageEntry = Schema.decodeUnknownEffect(AkeruUsageEntry);

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const readReported = Effect.fn("ProviderUsageHistory.readReported")(function* (
    window: ProviderUsageWindow,
  ) {
    const rows = yield* sql<UsageRow>`
      SELECT
        reservation_id AS "reservationId", source_key AS "sourceKey", bot_id AS "botId",
        thread_id AS "threadId", turn_id AS "turnId", category, state,
        reserved_tokens AS "reservedTokens", input_tokens AS "inputTokens",
        output_tokens AS "outputTokens", reasoning_tokens AS "reasoningTokens",
        provider, model, unavailable_reason AS "unavailableReason",
        created_at AS "createdAt", settled_at AS "settledAt"
      FROM akeru_bot_usage_entries
      WHERE state = 'reported'
        AND provider IS NOT NULL
        AND model IS NOT NULL
        AND created_at >= ${window.sinceAt}
        AND created_at < ${window.untilAt}
      ORDER BY created_at ASC, reservation_id ASC
    `.pipe(Effect.mapError(toPersistenceSqlError("ProviderUsageHistory.readReported")));

    return yield* Effect.forEach(rows, (row) =>
      decodeUsageEntry(row).pipe(
        Effect.mapError(toPersistenceDecodeError("ProviderUsageHistory.readReported")),
      ),
    );
  });

  return ProviderUsageHistory.of({ readReported });
});

export const layer = Layer.effect(ProviderUsageHistory, make);
