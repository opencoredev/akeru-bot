import { BotId, ChannelProvider, IsoDateTime, MessageId, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { toPersistenceSqlError, type ProjectionRepositoryError } from "../persistence/Errors.ts";

export const ChannelDeliveryClaim = Schema.Struct({
  messageId: MessageId,
  botId: BotId,
  threadId: ThreadId,
  provider: ChannelProvider,
  externalThreadId: Schema.String,
  requestedAt: IsoDateTime,
});
export type ChannelDeliveryClaim = typeof ChannelDeliveryClaim.Type;
export type ChannelDeliveryClaimResult = "claimed" | "requested" | "sent";

export interface ChannelDeliveryStoreShape {
  readonly claim: (
    input: ChannelDeliveryClaim,
  ) => Effect.Effect<ChannelDeliveryClaimResult, ProjectionRepositoryError>;
  /** Open delivery attempts left behind by an interrupted send. */
  readonly listRequestedClaims: () => Effect.Effect<
    ReadonlyArray<ChannelDeliveryClaim>,
    ProjectionRepositoryError
  >;
  /** Release only before transport starts or after confirmed non-delivery. */
  readonly releaseRequested: (
    messageId: MessageId,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly markSent: (input: {
    readonly messageId: MessageId;
    readonly sentAt: string;
  }) => Effect.Effect<void, ProjectionRepositoryError>;
}

export class ChannelDeliveryStore extends Context.Service<
  ChannelDeliveryStore,
  ChannelDeliveryStoreShape
>()("akeru-bot/channels/ChannelDeliveryStore") {}

export const makeChannelDeliveryStore = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const claim: ChannelDeliveryStoreShape["claim"] = (input) =>
    Effect.gen(function* () {
      const inserted = yield* sql<{ readonly messageId: string }>`
        INSERT OR IGNORE INTO channel_deliveries (
          message_id, bot_id, thread_id, provider, external_thread_id, status, requested_at, sent_at
        ) VALUES (
          ${input.messageId}, ${input.botId}, ${input.threadId}, ${input.provider},
          ${input.externalThreadId}, 'requested', ${input.requestedAt}, NULL
        )
        RETURNING message_id AS "messageId"
      `;
      if (inserted.length === 1) return "claimed" as const;
      const rows = yield* sql<{ readonly status: "requested" | "sent" }>`
        SELECT status FROM channel_deliveries WHERE message_id = ${input.messageId}
      `;
      return rows[0]?.status ?? "requested";
    }).pipe(Effect.mapError(toPersistenceSqlError("ChannelDeliveryStore.claim")));

  const releaseRequested: ChannelDeliveryStoreShape["releaseRequested"] = (messageId) =>
    sql`
      DELETE FROM channel_deliveries
      WHERE message_id = ${messageId} AND status = 'requested'
    `.pipe(
      Effect.asVoid,
      Effect.mapError(toPersistenceSqlError("ChannelDeliveryStore.releaseRequested")),
    );

  const markSent: ChannelDeliveryStoreShape["markSent"] = ({ messageId, sentAt }) =>
    sql`
      UPDATE channel_deliveries
      SET status = 'sent', sent_at = COALESCE(sent_at, ${sentAt})
      WHERE message_id = ${messageId}
    `.pipe(Effect.asVoid, Effect.mapError(toPersistenceSqlError("ChannelDeliveryStore.markSent")));

  const listRequestedClaims: ChannelDeliveryStoreShape["listRequestedClaims"] = () =>
    sql<{
      readonly messageId: string;
      readonly botId: string;
      readonly threadId: string;
      readonly provider: string;
      readonly externalThreadId: string;
      readonly requestedAt: string;
    }>`
      SELECT
        message_id AS "messageId",
        bot_id AS "botId",
        thread_id AS "threadId",
        provider,
        external_thread_id AS "externalThreadId",
        requested_at AS "requestedAt"
      FROM channel_deliveries
      WHERE status = 'requested'
    `.pipe(
      Effect.map((rows) =>
        rows.map(
          (row): ChannelDeliveryClaim => ({
            messageId: MessageId.make(row.messageId),
            botId: BotId.make(row.botId),
            threadId: ThreadId.make(row.threadId),
            provider: row.provider as ChannelDeliveryClaim["provider"],
            externalThreadId: row.externalThreadId,
            requestedAt: IsoDateTime.make(row.requestedAt),
          }),
        ),
      ),
      Effect.mapError(toPersistenceSqlError("ChannelDeliveryStore.listRequestedClaims")),
    );

  return {
    claim,
    listRequestedClaims,
    releaseRequested,
    markSent,
  } satisfies ChannelDeliveryStoreShape;
});

export const ChannelDeliveryStoreLive = Layer.effect(
  ChannelDeliveryStore,
  makeChannelDeliveryStore,
);

export function makeMemoryChannelDeliveryStore(): ChannelDeliveryStoreShape {
  const status = new Map<MessageId, "requested" | "sent">();
  const claims = new Map<MessageId, ChannelDeliveryClaim>();
  return {
    claim: (input) =>
      Effect.sync(() => {
        const existing = status.get(input.messageId);
        if (existing) return existing;
        status.set(input.messageId, "requested");
        claims.set(input.messageId, input);
        return "claimed";
      }),
    listRequestedClaims: () =>
      Effect.sync(() =>
        [...status.entries()].flatMap(([messageId, value]) =>
          value === "requested" ? [claims.get(messageId)!] : [],
        ),
      ),
    releaseRequested: (messageId) =>
      Effect.sync(() => {
        if (status.get(messageId) === "requested") {
          status.delete(messageId);
          claims.delete(messageId);
        }
      }),
    markSent: ({ messageId }) =>
      Effect.sync(() => {
        if (status.has(messageId)) status.set(messageId, "sent");
      }),
  };
}
