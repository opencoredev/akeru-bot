import { assert, it } from "@effect/vitest";
import { BotId, MessageId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../persistence/Migrations.ts";
import * as NodeSqliteClient from "../persistence/NodeSqliteClient.ts";
import {
  makeChannelDeliveryStore,
  makeMemoryChannelDeliveryStore,
} from "./ChannelDeliveryStore.ts";

const TestLayer = Layer.mergeAll(NodeSqliteClient.layerMemory());

it.layer(TestLayer)("channel delivery store", (it) => {
  it.effect("claims each assistant message once before transport", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      const store = yield* makeChannelDeliveryStore;
      const sql = yield* SqlClient.SqlClient;
      const claim = {
        messageId: MessageId.make("message-1"),
        botId: BotId.make("bot-1"),
        threadId: ThreadId.make("thread-1"),
        provider: "whatsapp" as const,
        externalThreadId: "chat-1",
        requestedAt: "2026-08-27T20:00:00.000Z",
      };

      const concurrentClaims = yield* Effect.all([store.claim(claim), store.claim(claim)], {
        concurrency: "unbounded",
      });
      assert.deepEqual(concurrentClaims.toSorted(), ["claimed", "requested"]);
      yield* store.markSent({
        messageId: claim.messageId,
        sentAt: "2026-08-27T20:00:01.000Z",
      });
      assert.equal(yield* store.claim(claim), "sent");

      const rows = yield* sql<{ readonly status: string; readonly sentAt: string | null }>`
        SELECT status, sent_at AS "sentAt"
        FROM channel_deliveries
        WHERE message_id = ${claim.messageId}
      `;
      assert.deepEqual(rows, [{ status: "sent", sentAt: "2026-08-27T20:00:01.000Z" }]);
    }),
  );

  it.effect("retains unfinished claims across store reconstruction until sent repair", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      const store = yield* makeChannelDeliveryStore;
      const claim = {
        messageId: MessageId.make("message-ambiguous"),
        botId: BotId.make("bot-1"),
        threadId: ThreadId.make("thread-1"),
        provider: "telegram" as const,
        externalThreadId: "chat-1",
        requestedAt: "2026-08-27T20:00:00.000Z",
      };
      assert.equal(yield* store.claim(claim), "claimed");
      const restored = yield* makeChannelDeliveryStore;
      assert.equal(yield* restored.claim(claim), "requested");
      yield* restored.markSent({ messageId: claim.messageId, sentAt: claim.requestedAt });
      assert.equal(yield* restored.claim(claim), "sent");
    }),
  );

  it.effect("keeps memory and SQL release and repair semantics equal", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      const sqlStore = yield* makeChannelDeliveryStore;
      for (const store of [sqlStore, makeMemoryChannelDeliveryStore()]) {
        const claim = {
          messageId: MessageId.make("message-store-parity"),
          botId: BotId.make("bot-1"),
          threadId: ThreadId.make("thread-1"),
          provider: "telegram" as const,
          externalThreadId: "chat-1",
          requestedAt: "2026-08-27T20:00:00.000Z",
        };
        yield* store.markSent({ messageId: claim.messageId, sentAt: claim.requestedAt });
        assert.equal(yield* store.claim(claim), "claimed");
        yield* store.releaseRequested(claim.messageId);
        assert.equal(yield* store.claim(claim), "claimed");
        yield* store.markSent({ messageId: claim.messageId, sentAt: claim.requestedAt });
        yield* store.releaseRequested(claim.messageId);
        assert.equal(yield* store.claim(claim), "sent");
      }
    }),
  );

  it.effect("releases only requested deliveries", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      const store = yield* makeChannelDeliveryStore;
      const claim = {
        messageId: MessageId.make("message-retry"),
        botId: BotId.make("bot-1"),
        threadId: ThreadId.make("thread-1"),
        provider: "telegram" as const,
        externalThreadId: "chat-1",
        requestedAt: "2026-08-27T20:00:00.000Z",
      };

      assert.equal(yield* store.claim(claim), "claimed");
      yield* store.releaseRequested(claim.messageId);
      assert.equal(yield* store.claim(claim), "claimed");
      yield* store.markSent({ messageId: claim.messageId, sentAt: claim.requestedAt });
      yield* store.releaseRequested(claim.messageId);
      assert.equal(yield* store.claim(claim), "sent");
    }),
  );
});
