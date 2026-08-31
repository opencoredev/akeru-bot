import { BotId, IsoDateTime, MessageId, ThreadId } from "@t3tools/contracts";
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
  provider: Schema.Literals(["telegram", "imessage"]),
  externalThreadId: Schema.String,
  requestedAt: IsoDateTime,
});
export type ChannelDeliveryClaim = typeof ChannelDeliveryClaim.Type;
export type ChannelDeliveryClaimResult = "claimed" | "requested" | "sent";

export interface ChannelDeliveryStoreShape {
  readonly claim: (
    input: ChannelDeliveryClaim,
  ) => Effect.Effect<ChannelDeliveryClaimResult, ProjectionRepositoryError>;
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

  return { claim, releaseRequested, markSent } satisfies ChannelDeliveryStoreShape;
});

export const ChannelDeliveryStoreLive = Layer.effect(
  ChannelDeliveryStore,
  makeChannelDeliveryStore,
);

export function makeMemoryChannelDeliveryStore(): ChannelDeliveryStoreShape {
  const status = new Map<MessageId, "requested" | "sent">();
  return {
    claim: (input) =>
      Effect.sync(() => {
        const existing = status.get(input.messageId);
        if (existing) return existing;
        status.set(input.messageId, "requested");
        return "claimed";
      }),
    releaseRequested: (messageId) => Effect.sync(() => void status.delete(messageId)),
    markSent: ({ messageId }) => Effect.sync(() => void status.set(messageId, "sent")),
  };
}
