import * as Predicate from "effect/Predicate";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ThreadId, WS_METHODS } from "@akeru/contracts";
import { assert, it } from "@effect/vitest";
import { assertTrue } from "@effect/vitest/utils";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import { HttpBody, HttpClient } from "effect/unstable/http";
import { vi } from "vite-plus/test";
import * as AgentController from "./provider/Services/AgentController.ts";
import { ProviderAdapterRequestError } from "./provider/Errors.ts";

import { buildAppUnderTest } from "./serverTestApp.ts";
import {
  getWsServerUrl,
  withWsRpcClient,
  crossOriginClientOrigin,
  assertBrowserApiCorsResponseHeaders,
} from "./serverTestClients.ts";
import { testEnvironmentDescriptor } from "./serverTestFixtures.ts";

it.layer(NodeServices.layer)("server router seam", (it) => {
  it.effect("uploads Codex thread feedback through websocket rpc", () =>
    Effect.gen(function* () {
      const input = {
        threadId: ThreadId.make("thread-feedback"),
        reason: "The agent stopped early.",
      };

      const uploadFeedback = vi.fn<AgentController.AgentController["Service"]["uploadFeedback"]>(
        () => Effect.succeed({ feedbackId: "codex-thread-feedback" }),
      );

      yield* buildAppUnderTest({
        layers: {
          agentController: { uploadFeedback },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");

      const response = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) => client[WS_METHODS.providerUploadFeedback](input)),
      );

      assert.deepStrictEqual(response, { feedbackId: "codex-thread-feedback" });
      assert.deepStrictEqual(uploadFeedback.mock.calls, [[input]]);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("uploads image bytes through a signed URL issued by websocket rpc", () =>
    Effect.gen(function* () {
      const config = yield* buildAppUnderTest();
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const wsUrl = yield* getWsServerUrl("/ws");

      yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          Effect.gen(function* () {
            const issued = yield* client[WS_METHODS.attachmentsCreateUploadUrl]({
              name: "screenshot.png",
              mimeType: "image/png",
              sizeBytes: 6,
            });

            const rejected = yield* HttpClient.post(issued.relativeUrl, {
              body: HttpBody.uint8Array(new Uint8Array([1, 2, 3]), "image/png"),
            });

            assert.equal(rejected.status, 400);

            const response = yield* HttpClient.post(issued.relativeUrl, {
              headers: { origin: crossOriginClientOrigin },
              body: HttpBody.uint8Array(new Uint8Array([1, 2, 3, 4, 5, 6]), "image/png"),
            });

            assert.equal(response.status, 204);
            assertBrowserApiCorsResponseHeaders(response.headers);

            const attachmentPath = path.join(config.attachmentsDir, `${issued.attachmentId}.png`);
            assert.isTrue(yield* fileSystem.exists(attachmentPath));

            yield* client[WS_METHODS.attachmentsDelete]({ attachmentId: issued.attachmentId });
            assert.isFalse(yield* fileSystem.exists(attachmentPath));

            const streamed = yield* client[WS_METHODS.attachmentsCreateUploadUrl]({
              name: "streamed.png",
              mimeType: "image/png",
              sizeBytes: 6,
            });

            const streamedResponse = yield* HttpClient.post(streamed.relativeUrl, {
              body: HttpBody.stream(Stream.make(new Uint8Array([1, 2, 3, 4, 5, 6])), "image/png"),
            });

            assert.equal(streamedResponse.status, 204);
            yield* client[WS_METHODS.attachmentsDelete]({ attachmentId: streamed.attachmentId });
          }),
        ),
      );
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("keeps feedback errors structured across websocket rpc", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread-feedback-failure");
      yield* buildAppUnderTest({
        layers: {
          agentController: {
            uploadFeedback: () =>
              Effect.fail(
                new ProviderAdapterRequestError({
                  provider: "codex",
                  method: "feedback/upload",
                  detail: "private provider detail",
                }),
              ),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");

      const error = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.providerUploadFeedback]({ threadId }).pipe(Effect.flip),
        ),
      );

      assert.strictEqual(error._tag, "ProviderUploadFeedbackError");

      if (Predicate.isTagged(error, "ProviderUploadFeedbackError")) {
        assert.strictEqual(error.threadId, threadId);
        assert.strictEqual(error.message, `Failed to upload feedback for thread ${threadId}.`);
        assert.isDefined(error.cause);
      }
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("shares one preview automation broker across websocket sessions", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* buildAppUnderTest();

        const wsUrl = yield* getWsServerUrl("/ws");
        const firstConnected = yield* Deferred.make<string>();
        const firstClosed = yield* Deferred.make<void>();

        const host = {
          clientId: "shared-preview-host",
          environmentId: testEnvironmentDescriptor.environmentId,
        } as const;

        yield* withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.previewAutomationConnect](host).pipe(
            Stream.tap((event) =>
              event.type === "connected"
                ? Deferred.succeed(firstConnected, event.connectionId)
                : Effect.void,
            ),
            Stream.runDrain,
            Effect.ensuring(Deferred.succeed(firstClosed, undefined)),
          ),
        ).pipe(Effect.forkScoped);

        const firstConnectionId = yield* Deferred.await(firstConnected);

        const replacementEvent = yield* withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.previewAutomationConnect](host).pipe(Stream.runHead),
        ).pipe(Effect.map(Option.getOrThrow));

        const firstStreamClosed = yield* Deferred.await(firstClosed).pipe(
          Effect.timeoutOption("2 seconds"),
        );

        assert.equal(replacementEvent.type, "connected");
        assert.notEqual(replacementEvent.connectionId, firstConnectionId);
        assert.isTrue(Option.isSome(firstStreamClosed));
      }),
    ).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("rejects websocket rpc handshake when session authentication is missing", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const workspaceDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-ws-auth-required-" });
      yield* fs.writeFileString(
        path.join(workspaceDir, "needle-file.ts"),
        "export const needle = 1;",
      );

      yield* buildAppUnderTest();

      const wsUrl = yield* getWsServerUrl("/ws", { authenticated: false });

      const result = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.projectsSearchEntries]({
            cwd: workspaceDir,
            query: "needle",
            limit: 10,
          }),
        ).pipe(Effect.result),
      );

      assertTrue(Predicate.isTagged(result, "Failure"));
      const failureMessage = String(result.failure);
      assertTrue(
        failureMessage.includes("SocketOpenError") || failureMessage.includes("SocketCloseError"),
      );
      assertTrue(
        failureMessage.includes("Unauthorized") ||
          failureMessage.includes("An error occurred during Open"),
      );
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );
});
