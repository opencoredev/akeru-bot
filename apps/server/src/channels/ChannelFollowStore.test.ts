import { assert, it } from "@effect/vitest";
import { BotId, ProjectId } from "@akeru/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";

import { runMigrations } from "../persistence/Migrations.ts";
import * as NodeSqliteClient from "../persistence/NodeSqliteClient.ts";
import { makeChannelFollowStore, memoryChannelFollowStore } from "./ChannelFollowStore.ts";

const TestLayer = Layer.mergeAll(NodeSqliteClient.layerMemory());

const key = {
  botId: BotId.make("bot-1"),
  provider: "slack" as const,
  projectId: ProjectId.make("project-1"),
  workspaceId: "T-HOME",
  externalThreadId: "slack:C1:1710000000.000100",
  senderId: "U-LEO",
};

it.layer(TestLayer)("channel follow store", (it) => {
  it.effect("keeps follows across store reconstruction, with memory and SQL in step", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      const sqlStore = yield* makeChannelFollowStore;

      for (const store of [sqlStore, memoryChannelFollowStore()]) {
        yield* store.touch(key, "2026-08-27T20:00:00.000Z");
        yield* store.touch(key, "2026-08-27T21:00:00.000Z");

        assert.deepEqual(yield* store.get(key), {
          ...key,
          startedAt: "2026-08-27T20:00:00.000Z",
          lastActivityAt: "2026-08-27T21:00:00.000Z",
        });
        assert.lengthOf(
          yield* store.listActive(key.botId, "slack", key.projectId, "2026-08-27T21:00:00.000Z"),
          1,
        );
        assert.lengthOf(
          yield* store.listActive(key.botId, "slack", key.projectId, "2026-08-27T21:00:00.001Z"),
          0,
        );
        assert.lengthOf(
          yield* store.listActive(key.botId, "discord", key.projectId, "2026-08-27T00:00:00.000Z"),
          0,
        );
        assert.lengthOf(
          yield* store.listActive(
            key.botId,
            "slack",
            ProjectId.make("project-2"),
            "2026-08-27T00:00:00.000Z",
          ),
          0,
        );
        assert.isUndefined(yield* store.get({ ...key, projectId: ProjectId.make("project-2") }));
      }

      const restored = yield* makeChannelFollowStore;
      assert.equal((yield* restored.get(key))?.senderId, "U-LEO");
      yield* restored.end(key);
      assert.isUndefined(yield* sqlStore.get(key));
    }),
  );

  it.effect("records each admitted message's outcome, across store reconstruction", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      const sqlStore = yield* makeChannelFollowStore;

      const message = (externalMessageId: string) => ({
        botId: key.botId,
        provider: "slack" as const,
        externalThreadId: key.externalThreadId,
        externalMessageId,
      });

      const turnMessage = message("1710000000.000100");
      const stopMessage = message("1710000000.000200");
      const at = "2026-08-27T20:00:00.000Z";
      const keepAll = "2026-08-20T20:00:00.000Z";

      for (const store of [sqlStore, memoryChannelFollowStore()]) {
        const claim = (entry: typeof turnMessage) => store.claimMessage(entry, at, keepAll);

        // Without a recorded outcome a claim stays evaluating, as a crash would leave it.
        assert.deepEqual(yield* claim(turnMessage), { status: "evaluating" });
        assert.deepEqual(yield* claim(turnMessage), { status: "evaluating" });
        yield* store.atomically(store.recordOutcome(turnMessage, "channel-turn-1"));
        assert.deepEqual(yield* claim(turnMessage), {
          status: "turn",
          turnCommandId: "channel-turn-1",
        });
        // An outcome is written once; a late second decision is refused and replaces nothing.
        assert.isFalse(yield* store.recordOutcome(turnMessage, undefined));
        assert.deepEqual(yield* claim(turnMessage), {
          status: "turn",
          turnCommandId: "channel-turn-1",
        });
        yield* store.finishMessage(turnMessage);
        assert.deepEqual(yield* claim(turnMessage), { status: "done" });

        yield* claim(stopMessage);
        yield* store.recordOutcome(stopMessage, undefined);
        assert.deepEqual(yield* claim(stopMessage), { status: "done" });
      }

      const restored = yield* makeChannelFollowStore;

      assert.deepEqual(yield* restored.claimMessage(turnMessage, at, keepAll), { status: "done" });

      // Once a claim is older than the retention cutoff it is dropped and starts over.
      for (const store of [restored, memoryChannelFollowStore()]) {
        yield* store.claimMessage(stopMessage, at, keepAll);
        yield* store.recordOutcome(stopMessage, undefined);

        assert.deepEqual(
          yield* store.claimMessage(
            stopMessage,
            "2026-09-05T20:00:00.000Z",
            "2026-08-29T00:00:00.000Z",
          ),
          { status: "evaluating" },
        );
      }
    }),
  );

  it.effect("rolls back a follow change when its outcome cannot be recorded", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      const rollbackKey = { ...key, senderId: "U-ROLLBACK" };

      for (const store of [yield* makeChannelFollowStore, memoryChannelFollowStore()]) {
        const failed = yield* Effect.exit(
          store.atomically(
            store
              .touch(rollbackKey, "2026-08-27T20:00:00.000Z")
              .pipe(Effect.andThen(Effect.fail("outcome write failed"))),
          ),
        );

        assert.isTrue(Exit.isFailure(failed));
        assert.isUndefined(yield* store.get(rollbackKey));
      }
    }),
  );
});
