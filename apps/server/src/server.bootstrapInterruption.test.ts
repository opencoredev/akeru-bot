import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { CommandId, MessageId, ORCHESTRATION_WS_METHODS, ThreadId } from "@akeru/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Cause from "effect/Cause";
import * as Exit from "effect/Exit";
import * as Stream from "effect/Stream";
import { buildAppUnderTest } from "./serverTestApp.ts";
import { getWsServerUrl, withWsRpcClient } from "./serverTestClients.ts";
import { defaultModelSelection, defaultProjectId } from "./serverTestFixtures.ts";

it.layer(NodeServices.layer)("bootstrap dispatch interruption", (it) => {
  it.effect("cleans up a created thread when turn dispatch interrupts", () =>
    Effect.gen(function* () {
      const commands: string[] = [];
      yield* buildAppUnderTest({
        layers: {
          orchestrationEngine: {
            dispatch: (command) =>
              Effect.gen(function* () {
                commands.push(command.type);

                if (command.type === "thread.turn.start") return yield* Effect.interrupt;

                return { sequence: commands.length };
              }),
            readEvents: () => Stream.empty,
          },
        },
      });
      const wsUrl = yield* getWsServerUrl("/ws");

      const exit = yield* Effect.exit(
        Effect.scoped(
          withWsRpcClient(wsUrl, (client) =>
            client[ORCHESTRATION_WS_METHODS.dispatchCommand]({
              type: "thread.turn.start",
              commandId: CommandId.make("cmd-bootstrap-interrupt"),
              threadId: ThreadId.make("thread-bootstrap-interrupt"),
              message: {
                messageId: MessageId.make("message-bootstrap-interrupt"),
                role: "user",
                text: "hello",
                attachments: [],
              },
              runtimeMode: "full-access",
              interactionMode: "default",
              bootstrap: {
                createThread: {
                  projectId: defaultProjectId,
                  title: "Bootstrap",
                  modelSelection: defaultModelSelection,
                  runtimeMode: "full-access",
                  interactionMode: "default",
                  branch: "main",
                  worktreePath: null,
                  createdAt: "2026-01-01T00:00:00.000Z",
                },
              },
              createdAt: "2026-01-01T00:00:00.000Z",
            }),
          ),
        ),
      );

      assert.isTrue(Exit.isFailure(exit));

      if (Exit.isFailure(exit)) assert.isTrue(Cause.hasInterruptsOnly(exit.cause));
      assert.deepEqual(commands, ["thread.create", "thread.turn.start", "thread.delete"]);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );
});
