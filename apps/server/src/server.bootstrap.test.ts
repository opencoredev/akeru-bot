import * as Predicate from "effect/Predicate";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  MessageId,
  type OrchestrationCommand,
  ORCHESTRATION_WS_METHODS,
  ThreadId,
  WS_METHODS,
} from "@akeru/contracts";
import { assert, it } from "@effect/vitest";
import { assertTrue } from "@effect/vitest/utils";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import { HttpBody, HttpClient } from "effect/unstable/http";
import { vi } from "vite-plus/test";
import { OrchestrationListenerCallbackError } from "./orchestration/Errors.ts";
import * as GitVcsDriver from "./vcs/GitVcsDriver.ts";
import { finishMaintenance, tryBeginMaintenance } from "./remote/updateGate.ts";

import { buildAppUnderTest } from "./serverTestApp.ts";
import {
  readyDefaultProvider,
  defaultModelSelection,
  defaultProjectId,
  readyWorktreeProvider,
  worktreeTestModelSelection,
} from "./serverTestFixtures.ts";
import { getWsServerUrl, withWsRpcClient } from "./serverTestClients.ts";

it.layer(NodeServices.layer)("server router seam", (it) => {
  it.effect(
    "bootstraps first-send worktree turns on the server before dispatching turn start",
    () =>
      Effect.gen(function* () {
        const dispatchedCommands: Array<OrchestrationCommand> = [];
        const bootstrapGitOperations: string[] = [];

        const remoteExists = vi.fn(
          (_: Parameters<GitVcsDriver.GitVcsDriver["Service"]["remoteExists"]>[0]) =>
            Effect.sync(() => {
              bootstrapGitOperations.push("remote-exists");

              return true;
            }),
        );

        const fetchRemote = vi.fn(
          (_: Parameters<GitVcsDriver.GitVcsDriver["Service"]["fetchRemote"]>[0]) =>
            Effect.sync(() => {
              bootstrapGitOperations.push("fetch");
            }),
        );

        const fetchedOriginCommit = "0123456789abcdef0123456789abcdef01234567";

        const resolveRemoteTrackingCommit = vi.fn(
          (_: Parameters<GitVcsDriver.GitVcsDriver["Service"]["resolveRemoteTrackingCommit"]>[0]) =>
            Effect.sync(() => {
              bootstrapGitOperations.push("resolve-remote-commit");

              return {
                commitSha: fetchedOriginCommit,
                remoteRefName: "origin/main",
              };
            }),
        );

        const createWorktree = vi.fn(
          (_: Parameters<GitVcsDriver.GitVcsDriver["Service"]["createWorktree"]>[0]) =>
            Effect.sync(() => {
              bootstrapGitOperations.push("create-worktree");

              return {
                worktree: {
                  refName: "t3code/bootstrap-refName",
                  path: "/tmp/bootstrap-worktree",
                },
              };
            }),
        );

        yield* buildAppUnderTest({
          layers: {
            providerRegistry: { getProviders: Effect.succeed([readyDefaultProvider]) },
            gitVcsDriver: {
              remoteExists,
              fetchRemote,
              resolveRemoteTrackingCommit,
              createWorktree,
            },
            orchestrationEngine: {
              dispatch: (command) =>
                Effect.sync(() => {
                  dispatchedCommands.push(command);

                  return { sequence: dispatchedCommands.length };
                }),
              readEvents: () => Stream.empty,
            },
          },
        });

        const createdAt = "2026-01-01T00:00:00.000Z";
        const wsUrl = yield* getWsServerUrl("/ws");

        const response = yield* Effect.scoped(
          withWsRpcClient(wsUrl, (client) =>
            client[ORCHESTRATION_WS_METHODS.dispatchCommand]({
              type: "thread.turn.start",
              commandId: CommandId.make("cmd-bootstrap-turn-start"),
              threadId: ThreadId.make("thread-bootstrap"),
              message: {
                messageId: MessageId.make("msg-bootstrap"),
                role: "user",
                text: "hello",
                attachments: [],
              },
              modelSelection: defaultModelSelection,
              runtimeMode: "full-access",
              interactionMode: "default",
              bootstrap: {
                createThread: {
                  projectId: defaultProjectId,
                  title: "Bootstrap Thread",
                  modelSelection: defaultModelSelection,
                  runtimeMode: "full-access",
                  interactionMode: "default",
                  branch: "main",
                  worktreePath: null,
                  createdAt,
                },
                prepareWorktree: {
                  projectCwd: "/tmp/project",
                  baseBranch: "main",
                  branch: "t3code/bootstrap-refName",
                  startFromOrigin: true,
                },
                runSetupScript: true,
              },
              createdAt,
            }),
          ),
        );

        assert.equal(response.sequence, 3);
        assert.deepEqual(
          dispatchedCommands.map((command) => command.type),
          ["thread.create", "thread.meta.update", "thread.turn.start"],
        );
        assert.deepEqual(createWorktree.mock.calls[0]?.[0], {
          cwd: "/tmp/project",
          refName: fetchedOriginCommit,
          newRefName: "t3code/bootstrap-refName",
          baseRefName: "main",
          path: null,
        });
        assert.deepEqual(fetchRemote.mock.calls[0]?.[0], {
          cwd: "/tmp/project",
          remoteName: "origin",
        });
        assert.deepEqual(resolveRemoteTrackingCommit.mock.calls[0]?.[0], {
          cwd: "/tmp/project",
          refName: "main",
          fallbackRemoteName: "origin",
        });
        assert.deepEqual(bootstrapGitOperations, [
          "remote-exists",
          "fetch",
          "resolve-remote-commit",
          "create-worktree",
        ]);
        const finalCommand = dispatchedCommands[2];
        assertTrue(finalCommand?.type === "thread.turn.start");

        if (finalCommand?.type === "thread.turn.start") {
          assert.equal(finalCommand.bootstrap, undefined);
        }
      }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("holds server updates from bootstrap setup through the final turn start", () =>
    Effect.gen(function* () {
      const dispatchedCommands: Array<OrchestrationCommand> = [];
      const finalDispatchAdmitted: Array<boolean> = [];
      let maintenanceStartedDuringBootstrap: boolean | undefined;

      const createWorktree = vi.fn(
        (_: Parameters<GitVcsDriver.GitVcsDriver["Service"]["createWorktree"]>[0]) =>
          Effect.sync(() => {
            maintenanceStartedDuringBootstrap = tryBeginMaintenance();

            if (maintenanceStartedDuringBootstrap) finishMaintenance();

            return {
              worktree: {
                refName: "t3code/bootstrap-admitted",
                path: "/tmp/bootstrap-admitted",
              },
            };
          }),
      );

      yield* buildAppUnderTest({
        layers: {
          providerRegistry: { getProviders: Effect.succeed([readyDefaultProvider]) },
          gitVcsDriver: { createWorktree },
          orchestrationEngine: {
            dispatch: (command, options) =>
              Effect.sync(() => {
                dispatchedCommands.push(command);

                if (command.type === "thread.turn.start") {
                  finalDispatchAdmitted.push(options?.admission !== undefined);
                }

                return { sequence: dispatchedCommands.length };
              }),
            readEvents: () => Stream.empty,
          },
        },
      });

      const createdAt = "2026-01-01T00:00:00.000Z";
      const wsUrl = yield* getWsServerUrl("/ws");

      const bootstrapTurnStart = (suffix: string) => ({
        type: "thread.turn.start" as const,
        commandId: CommandId.make(`cmd-bootstrap-admitted-${suffix}`),
        threadId: ThreadId.make(`thread-bootstrap-admitted-${suffix}`),
        message: {
          messageId: MessageId.make(`msg-bootstrap-admitted-${suffix}`),
          role: "user" as const,
          text: "hello",
          attachments: [],
        },
        modelSelection: defaultModelSelection,
        runtimeMode: "full-access" as const,
        interactionMode: "default" as const,
        bootstrap: {
          createThread: {
            projectId: defaultProjectId,
            title: "Bootstrap Thread",
            modelSelection: defaultModelSelection,
            runtimeMode: "full-access" as const,
            interactionMode: "default" as const,
            branch: "main",
            worktreePath: null,
            createdAt,
          },
          prepareWorktree: {
            projectCwd: "/tmp/project",
            baseBranch: "main",
            branch: "t3code/bootstrap-admitted",
          },
        },
        createdAt,
      });

      yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[ORCHESTRATION_WS_METHODS.dispatchCommand](bootstrapTurnStart("admitted")),
        ),
      );
      assert.equal(maintenanceStartedDuringBootstrap, false);
      assert.deepEqual(finalDispatchAdmitted, [true]);
      assert.equal(tryBeginMaintenance(), true);

      // An update already in progress blocks the bootstrap before any setup runs.
      try {
        dispatchedCommands.length = 0;

        const error = yield* Effect.scoped(
          withWsRpcClient(wsUrl, (client) =>
            client[ORCHESTRATION_WS_METHODS.dispatchCommand](bootstrapTurnStart("blocked")),
          ),
        ).pipe(Effect.flip);

        assert.include(String(error.message), "installing an update");
        assert.deepEqual(dispatchedCommands, []);
        assert.equal(createWorktree.mock.calls.length, 1);
      } finally {
        finishMaintenance();
      }
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect(
    "falls back to the local base branch when startFromOrigin is set but no origin remote exists",
    () =>
      Effect.gen(function* () {
        const dispatchedCommands: Array<OrchestrationCommand> = [];

        const remoteExists = vi.fn(
          (_: Parameters<GitVcsDriver.GitVcsDriver["Service"]["remoteExists"]>[0]) =>
            Effect.succeed(false),
        );

        const fetchRemote = vi.fn(
          (_: Parameters<GitVcsDriver.GitVcsDriver["Service"]["fetchRemote"]>[0]) => Effect.void,
        );

        const resolveRemoteTrackingCommit = vi.fn(
          (_: Parameters<GitVcsDriver.GitVcsDriver["Service"]["resolveRemoteTrackingCommit"]>[0]) =>
            Effect.succeed({
              commitSha: "0123456789abcdef0123456789abcdef01234567",
              remoteRefName: "origin/main",
            }),
        );

        const createWorktree = vi.fn(
          (_: Parameters<GitVcsDriver.GitVcsDriver["Service"]["createWorktree"]>[0]) =>
            Effect.succeed({
              worktree: {
                refName: "t3code/bootstrap-refName",
                path: "/tmp/bootstrap-worktree",
              },
            }),
        );

        yield* buildAppUnderTest({
          layers: {
            providerRegistry: { getProviders: Effect.succeed([readyDefaultProvider]) },
            gitVcsDriver: {
              remoteExists,
              fetchRemote,
              resolveRemoteTrackingCommit,
              createWorktree,
            },
            orchestrationEngine: {
              dispatch: (command) =>
                Effect.sync(() => {
                  dispatchedCommands.push(command);

                  return { sequence: dispatchedCommands.length };
                }),
              readEvents: () => Stream.empty,
            },
          },
        });

        const createdAt = "2026-01-01T00:00:00.000Z";
        const wsUrl = yield* getWsServerUrl("/ws");
        yield* Effect.scoped(
          withWsRpcClient(wsUrl, (client) =>
            client[ORCHESTRATION_WS_METHODS.dispatchCommand]({
              type: "thread.turn.start",
              commandId: CommandId.make("cmd-bootstrap-turn-start-no-origin"),
              threadId: ThreadId.make("thread-bootstrap-no-origin"),
              message: {
                messageId: MessageId.make("msg-bootstrap-no-origin"),
                role: "user",
                text: "hello",
                attachments: [],
              },
              modelSelection: defaultModelSelection,
              runtimeMode: "full-access",
              interactionMode: "default",
              bootstrap: {
                createThread: {
                  projectId: defaultProjectId,
                  title: "Bootstrap Thread",
                  modelSelection: defaultModelSelection,
                  runtimeMode: "full-access",
                  interactionMode: "default",
                  branch: "main",
                  worktreePath: null,
                  createdAt,
                },
                prepareWorktree: {
                  projectCwd: "/tmp/project",
                  baseBranch: "main",
                  branch: "t3code/bootstrap-refName",
                  startFromOrigin: true,
                },
              },
              createdAt,
            }),
          ),
        );

        assert.deepEqual(remoteExists.mock.calls[0]?.[0], {
          cwd: "/tmp/project",
          remoteName: "origin",
        });
        assert.equal(fetchRemote.mock.calls.length, 0);
        assert.equal(resolveRemoteTrackingCommit.mock.calls.length, 0);
        assert.deepEqual(createWorktree.mock.calls[0]?.[0], {
          cwd: "/tmp/project",
          refName: "main",
          newRefName: "t3code/bootstrap-refName",
          baseRefName: "main",
          path: null,
        });
      }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("cleans up created bootstrap threads when worktree creation defects", () =>
    Effect.gen(function* () {
      const dispatchedCommands: Array<OrchestrationCommand> = [];
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;

      const createWorktree = vi.fn(
        (_: Parameters<GitVcsDriver.GitVcsDriver["Service"]["createWorktree"]>[0]) =>
          Effect.die(new Error("worktree exploded")),
      );

      const config = yield* buildAppUnderTest({
        layers: {
          providerRegistry: { getProviders: Effect.succeed([readyWorktreeProvider]) },
          gitVcsDriver: {
            createWorktree,
          },
          orchestrationEngine: {
            dispatch: (command) =>
              Effect.sync(() => {
                dispatchedCommands.push(command);

                return { sequence: dispatchedCommands.length };
              }),
            readEvents: () => Stream.empty,
          },
        },
      });

      const createdAt = "2026-01-01T00:00:00.000Z";
      const wsUrl = yield* getWsServerUrl("/ws");
      let pendingAttachmentId: string | undefined;

      const result = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          Effect.gen(function* () {
            const upload = yield* client[WS_METHODS.attachmentsCreateUploadUrl]({
              name: "screenshot.png",
              mimeType: "image/png",
              sizeBytes: 6,
            });

            pendingAttachmentId = upload.attachmentId;

            const uploadResponse = yield* HttpClient.post(upload.relativeUrl, {
              body: HttpBody.uint8Array(new Uint8Array([1, 2, 3, 4, 5, 6]), "image/png"),
            });

            assert.equal(uploadResponse.status, 204);

            return yield* client[ORCHESTRATION_WS_METHODS.dispatchCommand]({
              type: "thread.turn.start",
              commandId: CommandId.make("cmd-bootstrap-turn-start-defect"),
              threadId: ThreadId.make("thread-bootstrap-defect"),
              message: {
                messageId: MessageId.make("msg-bootstrap-defect"),
                role: "user",
                text: "hello",
                attachments: [
                  {
                    type: "image",
                    id: upload.attachmentId,
                    name: "screenshot.png",
                    mimeType: "image/png",
                    sizeBytes: 6,
                  },
                ],
              },
              modelSelection: worktreeTestModelSelection,
              runtimeMode: "full-access",
              interactionMode: "default",
              bootstrap: {
                createThread: {
                  projectId: defaultProjectId,
                  title: "Bootstrap Thread",
                  modelSelection: worktreeTestModelSelection,
                  runtimeMode: "full-access",
                  interactionMode: "default",
                  branch: "main",
                  worktreePath: null,
                  createdAt,
                },
                prepareWorktree: {
                  projectCwd: "/tmp/project",
                  baseBranch: "main",
                  branch: "t3code/bootstrap-refName",
                },
                runSetupScript: false,
              },
              createdAt,
            });
          }),
        ).pipe(Effect.result),
      );

      assertTrue(Predicate.isTagged(result, "Failure"));
      assertTrue(Predicate.isTagged(result.failure, "OrchestrationDispatchCommandError"));
      assert.include(result.failure.message, "worktree exploded");
      assert.strictEqual(result.failure.bootstrapThreadDisposition, "deleted");
      assert.deepEqual(
        dispatchedCommands.map((command) => command.type),
        ["thread.create", "thread.delete"],
      );
      assert.isDefined(pendingAttachmentId);
      assert.isTrue(
        yield* fileSystem.exists(path.join(config.attachmentsDir, `${pendingAttachmentId}.png`)),
      );
      assert.deepEqual(yield* fileSystem.readDirectory(config.attachmentsDir), [
        `${pendingAttachmentId}.png`,
      ]);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("does not report a deleted bootstrap thread when cleanup fails", () =>
    Effect.gen(function* () {
      const dispatchedCommands: Array<OrchestrationCommand> = [];

      const createWorktree = vi.fn(
        (_: Parameters<GitVcsDriver.GitVcsDriver["Service"]["createWorktree"]>[0]) =>
          Effect.die(new Error("worktree exploded")),
      );

      yield* buildAppUnderTest({
        layers: {
          providerRegistry: { getProviders: Effect.succeed([readyWorktreeProvider]) },
          gitVcsDriver: {
            createWorktree,
          },
          orchestrationEngine: {
            dispatch: (command) => {
              dispatchedCommands.push(command);

              if (command.type === "thread.delete") {
                return Effect.fail(
                  new OrchestrationListenerCallbackError({
                    listener: "domain-event",
                    detail: "thread cleanup exploded",
                  }),
                );
              }

              return Effect.succeed({ sequence: dispatchedCommands.length });
            },
            readEvents: () => Stream.empty,
          },
        },
      });

      const createdAt = "2026-01-01T00:00:00.000Z";
      const wsUrl = yield* getWsServerUrl("/ws");

      const result = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[ORCHESTRATION_WS_METHODS.dispatchCommand]({
            type: "thread.turn.start",
            commandId: CommandId.make("cmd-bootstrap-turn-start-cleanup-defect"),
            threadId: ThreadId.make("thread-bootstrap-cleanup-defect"),
            message: {
              messageId: MessageId.make("msg-bootstrap-cleanup-defect"),
              role: "user",
              text: "hello",
              attachments: [],
            },
            modelSelection: worktreeTestModelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            bootstrap: {
              createThread: {
                projectId: defaultProjectId,
                title: "Bootstrap Thread",
                modelSelection: worktreeTestModelSelection,
                runtimeMode: "full-access",
                interactionMode: "default",
                branch: "main",
                worktreePath: null,
                createdAt,
              },
              prepareWorktree: {
                projectCwd: "/tmp/project",
                baseBranch: "main",
                branch: "t3code/bootstrap-refName",
              },
              runSetupScript: false,
            },
            createdAt,
          }),
        ).pipe(Effect.result),
      );

      assertTrue(Predicate.isTagged(result, "Failure"));
      assertTrue(Predicate.isTagged(result.failure, "OrchestrationDispatchCommandError"));
      assert.include(result.failure.message, "worktree exploded");
      assert.strictEqual(result.failure.bootstrapThreadDisposition, undefined);
      assert.deepEqual(
        dispatchedCommands.map((command) => command.type),
        ["thread.create", "thread.delete"],
      );
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );
});
