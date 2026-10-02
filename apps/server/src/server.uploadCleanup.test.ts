import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  type ClientOrchestrationCommand,
  CommandId,
  MessageId,
  ORCHESTRATION_WS_METHODS,
} from "@akeru/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import { HttpBody, HttpClient } from "effect/unstable/http";
import { buildAppUnderTest } from "./serverTestApp.ts";
import { exchangeAccessToken, getWsServerUrl, withWsRpcClient } from "./serverTestClients.ts";
import { defaultDesktopBootstrapToken, defaultThreadId } from "./serverTestFixtures.ts";

// The interruption case comes from the engine itself, so the turn never
// committed and its claimed upload must go. A caller cancelling a turn the
// engine still commits is covered in dispatchUploadCancellation.test.ts.
it.layer(NodeServices.layer)("dispatch upload cleanup", (it) => {
  for (const transport of ["HTTP", "WebSocket"]) {
    it.effect.each(["defect", "interruption"])(
      `removes claimed uploads after ${transport} dispatch %s`,
      (failure) =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          let dispatchCount = 0;

          const config = yield* buildAppUnderTest({
            layers: {
              orchestrationEngine: {
                dispatch: () =>
                  Effect.sync(() => {
                    dispatchCount++;
                  }).pipe(
                    Effect.andThen(
                      failure === "defect" ? Effect.die("projection defect") : Effect.interrupt,
                    ),
                  ),
                readEvents: () => Stream.empty,
              },
            },
          });

          const attachmentId = "pending-11111111-1111-4111-8111-111111111111";
          yield* fileSystem.makeDirectory(config.attachmentsDir, { recursive: true });
          yield* fileSystem.writeFile(
            path.join(config.attachmentsDir, `${attachmentId}.png`),
            Buffer.from("pixels"),
          );

          const command = {
            type: "thread.turn.start",
            commandId: CommandId.make("cmd-upload-failure"),
            threadId: defaultThreadId,
            message: {
              messageId: MessageId.make("msg-upload-failure"),
              role: "user",
              text: "Start chat",
              attachments: [
                {
                  type: "image",
                  id: attachmentId,
                  name: "screenshot.png",
                  mimeType: "image/png",
                  sizeBytes: 6,
                },
              ],
            },
            runtimeMode: "full-access",
            interactionMode: "default",
            createdAt: "2026-01-01T00:00:00.000Z",
          } satisfies ClientOrchestrationCommand;

          if (transport === "HTTP") {
            const { body: tokenBody } = yield* exchangeAccessToken(defaultDesktopBootstrapToken, {
              scope: "orchestration:operate",
            });

            const response = yield* HttpClient.post("/api/orchestration/dispatch", {
              headers: { authorization: `Bearer ${tokenBody.access_token ?? ""}` },
              body: yield* HttpBody.json(command),
            });

            assert.equal(response.status, failure === "defect" ? 500 : 503);
          } else {
            const wsUrl = yield* getWsServerUrl("/ws");

            const exit = yield* Effect.exit(
              Effect.scoped(
                withWsRpcClient(wsUrl, (client) =>
                  client[ORCHESTRATION_WS_METHODS.dispatchCommand](command),
                ),
              ),
            );

            assert.isTrue(Exit.isFailure(exit));
          }

          assert.equal(dispatchCount, 1);
          assert.deepEqual(yield* fileSystem.readDirectory(config.attachmentsDir), [
            `${attachmentId}.png`,
          ]);
        }).pipe(Effect.provide(NodeHttpServer.layerTest)),
    );
  }
});
