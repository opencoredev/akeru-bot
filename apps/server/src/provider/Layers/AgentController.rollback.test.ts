// @effect-diagnostics globalDate:off globalFetch:off globalFetchInEffect:off nodeBuiltinImport:off preferSchemaOverJson:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import type { MastraDBMessage, Session } from "@mastra/core/agent-controller";
import { MessageId, ProviderDriverKind, ThreadId, TurnId } from "@akeru/contracts";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { assert, describe, expect, vi } from "vite-plus/test";
import { ServerConfig } from "../../config.ts";
import { AgentController } from "../Services/AgentController.ts";
import { makeAkeruMastraHarness, type AkeruMastraHarness } from "../AkeruMastraHarness.ts";
import { type AgentControllerLiveOptions } from "./AgentController.ts";
import * as ProjectionSnapshotQuery from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import {
  ProjectionThreadMessageRepository,
  type ProjectionThreadMessage,
} from "../../persistence/Services/ProjectionThreadMessages.ts";
import {
  ProjectionTurnRepository,
  type ProjectionTurn,
} from "../../persistence/Services/ProjectionTurns.ts";
import {
  codexThreadId,
  kimiThreadId,
  codexInstanceId,
  kimiInstanceId,
  codexSelection,
} from "./test-support/agentControllerFixtures.ts";
import {
  makeBridge,
  makeLayer,
  provideController,
  bossBotId,
  linearServer,
  groupParentSnapshot,
} from "./test-support/agentControllerLayers.ts";
import { makeMastraHarness } from "./test-support/agentControllerHarness.ts";

describe("AgentControllerLive", () => {
  it.effect.each(["codex", "kimi"] as const)(
    "restarts %s with only retained turns in the next turn's Mastra context",
    (provider) => {
      const bridge = makeBridge();
      const threadId = provider === "codex" ? codexThreadId : kimiThreadId;

      const selection =
        provider === "codex" ? codexSelection : { instanceId: kimiInstanceId, model: "k3-256k" };

      const createdAt = "2026-01-01T00:00:00.000Z";

      const attachment = {
        type: "image" as const,
        id: `${threadId}-12345678-1234-1234-1234-123456789abc`,
        name: "retained.png",
        mimeType: "image/png",
        sizeBytes: 1,
      };

      const messages: ProjectionThreadMessage[] = [1, 2].flatMap((count) =>
        (["user", "assistant"] as const).map((role) => ({
          messageId: MessageId.make(`${role}-${count}`),
          threadId,
          turnId: role === "user" ? null : TurnId.make(`turn-${count}`),
          role,
          text: `${role} turn ${count}`,
          isStreaming: false,
          createdAt,
          updatedAt: createdAt,
          attachments: count === 1 && role === "user" ? [attachment] : [],
        })),
      );

      const turns: ProjectionTurn[] = [1, 2].map((count) => ({
        threadId,
        turnId: TurnId.make(`turn-${count}`),
        pendingMessageId: MessageId.make(`user-${count}`),
        assistantMessageId: MessageId.make(`assistant-${count}`),
        sourceProposedPlanThreadId: null,
        sourceProposedPlanId: null,
        respondingBotId: null,
        state: "completed",
        requestedAt: createdAt,
        startedAt: createdAt,
        completedAt: createdAt,
        checkpointTurnCount: count,
        checkpointRef: null,
        checkpointStatus: null,
        checkpointFiles: [],
      }));

      const nextContext = Promise.withResolvers<MastraDBMessage[]>();
      const dispatchStarted = Promise.withResolvers<void>();
      const finishDispatch = Promise.withResolvers<void>();
      const dispatchAborted = Promise.withResolvers<void>();
      const sessions: Session<Record<string, unknown>>[] = [];
      let harness: AkeruMastraHarness | undefined;
      let failRestart = false;

      const factory: NonNullable<AgentControllerLiveOptions["makeMastraHarness"]> = (options) =>
        Effect.gen(function* () {
          const real = yield* makeAkeruMastraHarness(options);
          harness = real;
          yield* Effect.promise(() =>
            real.rebuildConversation!(
              String(threadId),
              messages.map((message) => ({
                id: String(message.messageId),
                role: message.role,
                content: { format: 2, parts: [{ type: "text", text: message.text }] },
                createdAt: new Date(message.createdAt),
                threadId: String(threadId),
                resourceId: String(threadId),
              })),
            ),
          );

          return {
            ...real,
            observeAfterTurn: async () => undefined,
            controller: {
              ...real.controller,
              init: () => real.controller.init(),
              deleteSession: (input) => real.controller.deleteSession(input),
              createSession: async (input) => {
                if (failRestart) {
                  failRestart = false;
                  throw new Error("Restart failed");
                }

                const session = await real.controller.createSession(input);
                sessions.push(session);

                if (sessions.length === 1) {
                  const abort = session.abort.bind(session);
                  vi.spyOn(session, "abort").mockImplementation(() => {
                    abort();
                    dispatchAborted.resolve();
                  });
                }

                vi.spyOn(session, "sendMessage").mockImplementation(async () => {
                  if (sessions.length === 1) {
                    dispatchStarted.resolve();
                    await finishDispatch.promise;

                    return;
                  }

                  nextContext.resolve(await session.thread.listActiveMessages());
                });

                return session;
              },
            },
          };
        });

      return Effect.gen(function* () {
        const controller = yield* AgentController;
        const config = yield* ServerConfig;
        NodeFS.mkdirSync(config.attachmentsDir, { recursive: true });
        NodeFS.writeFileSync(NodePath.join(config.attachmentsDir, `${attachment.id}.png`), "x");
        yield* controller.resolveEngine({
          threadId,
          engine: null,
          fallback: selection,
          mode: "default",
          botConversation: true,
        });
        yield* controller.startSession(threadId, {
          threadId,
          provider: ProviderDriverKind.make(provider),
          providerInstanceId: selection.instanceId,
          modelSelection: selection,
          runtimeMode: "approval-required",
          cwd: process.cwd(),
        });
        const before = yield* Effect.promise(() => sessions[0]!.thread.listActiveMessages());
        expect(before.map((message) => message.id)).toEqual([
          "user-1",
          "assistant-1",
          "user-2",
          "assistant-2",
        ]);
        yield* Effect.promise(() =>
          harness!.restoreObservationalMemory!(String(threadId), {
            current: {
              id: "discarded-observation",
              generationCount: 1,
              activeObservations: "Facts from discarded turn 2",
              bufferedObservations: "",
              bufferedReflection: null,
              totalTokensObserved: 10,
              observationTokenCount: 2,
              createdAt,
              updatedAt: createdAt,
              originType: "initial",
            },
            history: [],
          }),
        );
        yield* controller.sendTurn({ threadId, input: "Discarded in-flight turn" });
        yield* Effect.promise(() => dispatchStarted.promise);

        const rollback = yield* controller
          .rollbackConversation({ threadId, numTurns: 1 })
          .pipe(Effect.forkChild({ startImmediately: true }));

        yield* Effect.promise(() => dispatchAborted.promise);
        expect(sessions).toHaveLength(1);
        finishDispatch.resolve();
        yield* Fiber.join(rollback);
        expect(
          yield* Effect.promise(() => harness!.readObservationalMemory!(String(threadId))),
        ).toEqual({ current: null, history: [] });
        expect(sessions).toHaveLength(2);
        expect(sessions[1]).not.toBe(sessions[0]);
        yield* controller.sendTurn({ threadId, input: "Next turn" });
        const context = yield* Effect.promise(() => nextContext.promise);
        expect(context.map((message) => message.id)).toEqual(["user-1", "assistant-1"]);
        expect(context[0]?.content.parts).toEqual([
          {
            type: "text",
            text: `user turn 1\n\n[Attached image "retained.png" is saved at: ${NodePath.join(config.attachmentsDir, `${attachment.id}.png`)}]`,
          },
        ]);
        expect(context[0]?.content.experimental_attachments).toEqual([
          {
            name: "retained.png",
            contentType: "image/png",
            url: "data:image/png;base64,eA==",
          },
        ]);
        expect(context[1]?.content.parts).toEqual([{ type: "text", text: "assistant turn 1" }]);
        yield* controller.interruptTurn({ threadId });
        turns.splice(1);
        messages.splice(2);
        failRestart = true;

        const failedRestart = yield* controller
          .rollbackConversation({ threadId, numTurns: 1 })
          .pipe(Effect.exit);

        expect(Exit.isFailure(failedRestart)).toBe(true);
        // The original session reopens without another start request.
        expect(sessions).toHaveLength(3);
        expect(
          (yield* Effect.promise(() => sessions[2]!.thread.listActiveMessages())).map(
            (message) => message.id,
          ),
        ).toEqual(["user-1", "assistant-1"]);
        yield* controller.rollbackConversation({ threadId, numTurns: 1 });
        expect(sessions).toHaveLength(4);
        expect(yield* Effect.promise(() => sessions[3]!.thread.listActiveMessages())).toEqual([]);
        yield* controller.stopSession({ threadId });
        yield* controller.startSession(threadId, {
          threadId,
          modelSelection: selection,
          runtimeMode: "approval-required",
        });
        expect(yield* Effect.promise(() => sessions[4]!.thread.listActiveMessages())).toEqual([]);
        expect(bridge.rollbackConversation).not.toHaveBeenCalled();
      }).pipe(
        Effect.provide(
          makeLayer(bridge.service, factory).pipe(
            Layer.provide(
              Layer.mock(ProjectionThreadMessageRepository)({
                listByThreadId: () => Effect.succeed(messages),
              }),
            ),
            Layer.provide(
              Layer.mock(ProjectionTurnRepository)({
                listByThreadId: () => Effect.succeed(turns),
              }),
            ),
          ),
        ),
      );
    },
  );
});

describe("AgentControllerLive", () => {
  describe("temporary workers", () => {
    it.effect("rebuilds an orphaned worker grant from its delegated parent after a restart", () => {
      const bridge = makeBridge();
      const mastra = makeMastraHarness();

      const mcpManager = {
        init: vi.fn(async () => undefined),
        disconnect: vi.fn(async () => undefined),
        getTools: vi.fn(() => ({ linear_update: { mcp: { annotations: {} } } })),
        getServerStatuses: vi.fn(() => []),
      };

      // The worker's parent is a delegated chat limited to Task and WebSearch.
      const delegatedParentThreadId = ThreadId.make("thread-delegated-parent");
      const orphanThreadId = ThreadId.make("worker-thread-restricted");

      const parentDelegation = {
        delegationId: "delegation-restricted",
        parentThreadId: codexThreadId,
        phase: {
          _tag: "Completed",
          childThreadId: delegatedParentThreadId,
          childTurnId: null,
          startedAt: "2026-09-01T00:00:00.000Z",
          completedAt: "2026-09-01T00:01:00.000Z",
          result: { summary: "Done.", childThreadId: delegatedParentThreadId },
          acknowledgedAt: null,
        },
        access: {
          allowedToolIds: ["Task", "WebSearch"],
          memoryScopes: [],
          sandbox: null,
          runtimeMode: "approval-required",
          hasUserComputer: false,
          enabledMcpServerIds: [],
          disabledMcpServerIds: [],
          approvalCeiling: "none",
        },
      };

      return provideController(
        Effect.gen(function* () {
          const controller = yield* AgentController;
          yield* controller.configureDelegation!({
            readSnapshot: async () => groupParentSnapshot,
            dispatch: async () => ({ sequence: 1 }),
          });
          yield* controller.resolveEngine({
            threadId: orphanThreadId,
            engine: null,
            fallback: codexSelection,
            mode: "default",
            botConversation: true,
          });
          yield* controller.startSession(orphanThreadId, {
            threadId: orphanThreadId,
            provider: ProviderDriverKind.make("codex"),
            providerInstanceId: codexInstanceId,
            cwd: process.cwd(),
            modelSelection: codexSelection,
            runtimeMode: "approval-required",
            botId: bossBotId,
            botName: "Boss",
            mcpServers: [linearServer],
          });
          const runtime = mastra.harnessOptions[0]?.toolRuntime;
          assert.isDefined(runtime);
          const tools = runtime.toolsForThread(String(orphanThreadId)).map((tool) => tool.id);
          expect(tools).toContain("WebSearch");

          for (const toolId of ["Read", "Task", "linear_update"]) {
            expect(tools).not.toContain(toolId);
          }
        }),
        bridge.service,
        mastra.factory,
        () => mcpManager as never,
      ).pipe(
        Effect.provideService(
          ProjectionSnapshotQuery.ProjectionSnapshotQuery,
          ProjectionSnapshotQuery.ProjectionSnapshotQuery.of({
            getThreadRuntimeContext: (threadId: ThreadId) =>
              Effect.succeed(
                Option.some(
                  threadId === orphanThreadId
                    ? { botId: bossBotId, parentThreadId: delegatedParentThreadId }
                    : { botId: bossBotId },
                ),
              ),
            getBotById: () => Effect.succeed(Option.none()),
            getGroupById: () => Effect.succeed(Option.none()),
            listThreadDelegations: (threadId: ThreadId) =>
              Effect.succeed(threadId === delegatedParentThreadId ? [parentDelegation] : []),
          } as unknown as ProjectionSnapshotQuery.ProjectionSnapshotQuery["Service"]),
        ),
      );
    });
  });
});
