import { CommandId, ThreadId } from "@akeru/contracts";
import { assert } from "@effect/vitest";
import * as Predicate from "effect/Predicate";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { decideOrchestrationCommand } from "../decider.ts";
import { makeReadModel, createSession } from "../test-support/SettledDeciderFixtures.ts";
import { projectionSnapshotLayer } from "./test-support/ProjectionSnapshotHarness.ts";

projectionSnapshotLayer("command context timestamps", (it) => {
  it.effect("preserves queued-work guards with mixed offsets and fractional seconds", () =>
    Effect.gen(function* () {
      const query = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;
      const threadId = ThreadId.make("thread-1");
      const timestamps = ["1969-12-31T23:57:30Z", "1969-12-31T19:59:30.001-04:00"];

      for (const [index, timestamp] of timestamps.entries()) {
        yield* sql`
          INSERT INTO projection_thread_messages
            (message_id, thread_id, role, text, is_streaming, created_at, updated_at)
          VALUES (${`message-${index}`}, ${threadId}, 'user', '', 0, ${timestamp}, ${timestamp})
        `;
      }

      assert.isDefined(query.getThreadCommandContext);

      if (!query.getThreadCommandContext) return;
      const context = yield* query.getThreadCommandContext(threadId);
      assert.equal(context.messages.length, 1);
      assert.equal(context.messages[0]?.createdAt, timestamps[1]);

      for (const command of [
        { type: "thread.settle", commandId: CommandId.make("settle-offsets"), threadId },
        {
          type: "thread.snooze",
          commandId: CommandId.make("snooze-offsets"),
          threadId,
          snoozedUntil: "1970-01-01T01:00:00Z",
        },
      ] as const) {
        const error = yield* decideOrchestrationCommand({
          command,
          readModel: makeReadModel(null, null, createSession("ready"), [], context.messages),
        }).pipe(Effect.flip);

        assert.equal(error._tag, "OrchestrationCommandInvariantError");

        if (Predicate.isTagged(error, "OrchestrationCommandInvariantError")) {
          assert.include(error.detail, "queued turn start");
        }
      }

      yield* sql`
        INSERT INTO projection_thread_messages
          (message_id, thread_id, role, text, is_streaming, created_at, updated_at)
        VALUES ('message-fraction', ${threadId}, 'user', '', 0, '1969-12-31T23:59:30.000Z', '1969-12-31T23:59:30.000Z')
      `;
      const fractionalContext = yield* query.getThreadCommandContext(threadId);
      assert.equal(fractionalContext.messages[0]?.createdAt, timestamps[1]);
    }),
  );
});
