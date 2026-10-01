// @effect-diagnostics globalDate:off globalFetch:off globalFetchInEffect:off nodeBuiltinImport:off preferSchemaOverJson:off
import type { AgentControllerEvent } from "@mastra/core/agent-controller";
import {
  ProviderDriverKind,
  ThreadId,
  type OrchestrationCommand,
  type ProviderRuntimeEvent,
} from "@akeru/contracts";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import { assert, describe, expect, vi } from "vite-plus/test";
import { AgentController } from "../Services/AgentController.ts";
import {
  codexThreadId,
  codexInstanceId,
  codexSelection,
} from "./test-support/agentControllerFixtures.ts";
import {
  makeBridge,
  provideController,
  resolveCodex,
  bossBotId,
  linearServer,
  groupParentSnapshot,
  makeWorkerSession,
} from "./test-support/agentControllerLayers.ts";
import { mastraHarnessFixture } from "./test-support/agentControllerHarness.ts";

describe("AgentControllerLive", () => {
  describe("temporary workers", () => {
    it.effect("runs a Task from a group chat as a direct, locked-down worker", () => {
      const bridge = makeBridge();
      const mastra = mastraHarnessFixture();
      const worker = makeWorkerSession(mastra.session);

      const mcpManager = {
        init: vi.fn(async () => undefined),
        disconnect: vi.fn(async () => undefined),
        getTools: vi.fn(() => ({ linear_update: { mcp: { annotations: {} } } })),
        getServerStatuses: vi.fn(() => []),
      };

      const dispatched: OrchestrationCommand[] = [];
      const turnStarted = Promise.withResolvers<void>();

      return provideController(
        Effect.gen(function* () {
          const controller = yield* AgentController;
          yield* controller.configureDelegation!({
            readSnapshot: async () => groupParentSnapshot,
            dispatch: async (command) => {
              dispatched.push(command);

              if (command.type === "thread.turn.start") turnStarted.resolve();

              return { sequence: dispatched.length };
            },
          });
          yield* resolveCodex(controller);

          const sessionInput = {
            provider: ProviderDriverKind.make("codex"),
            providerInstanceId: codexInstanceId,
            cwd: process.cwd(),
            modelSelection: codexSelection,
            runtimeMode: "approval-required" as const,
            botId: bossBotId,
            botName: "Boss",
            mcpServers: [linearServer],
          };

          yield* controller.startSession(codexThreadId, {
            ...sessionInput,
            threadId: codexThreadId,
          });
          yield* controller.sendTurn({ threadId: codexThreadId, input: "Split this up." });

          const runtime = mastra.harnessOptions[0]?.toolRuntime;
          assert.isDefined(runtime);
          const parentTools = runtime.toolsForThread(String(codexThreadId)).map((tool) => tool.id);
          expect(parentTools).toEqual(expect.arrayContaining(["Task", "ExternalShell"]));

          const spawned = (yield* Effect.promise(() =>
            runtime.execute({
              threadId: String(codexThreadId),
              toolId: "Task",
              toolCallId: "task-1",
              input: { task: "Update the Linear issue", background: true },
              approvalMode: "require-grant",
            }),
          )) as { readonly phase: { readonly _tag: string } };

          expect(spawned.phase._tag).toBe("Running");
          yield* Effect.promise(() => turnStarted.promise);
          const [create, start] = dispatched;
          expect(create).toMatchObject({
            type: "thread.create",
            botId: bossBotId,
            groupId: null,
            parentThreadId: codexThreadId,
          });
          assert(create?.type === "thread.create");
          const childThreadId = create.threadId;
          expect(start).toMatchObject({ type: "thread.turn.start", threadId: childThreadId });
          expect(start).not.toHaveProperty("respondingBotId");

          // The turn-start reactor would start the worker session like this.
          mastra.createSession.mockImplementationOnce(async () => worker.session as never);
          yield* controller.resolveEngine({
            threadId: childThreadId,
            engine: null,
            fallback: codexSelection,
            mode: "default",
            botConversation: true,
          });
          yield* controller.startSession(childThreadId, {
            ...sessionInput,
            threadId: childThreadId,
          });
          const workerTools = runtime.toolsForThread(String(childThreadId)).map((tool) => tool.id);

          for (const toolId of [
            "Task",
            "request_box_help",
            "ReactToMessage",
            "ExternalShell",
            "AwaitExternalShell",
          ]) {
            expect(workerTools).not.toContain(toolId);
          }

          const events: ProviderRuntimeEvent[] = [];

          const eventsFiber = yield* controller.streamEvents.pipe(
            Stream.runForEach((event) => Effect.sync(() => events.push(event))),
            Effect.forkChild({ startImmediately: true }),
          );

          yield* Effect.yieldNow;
          yield* controller.sendTurn({ threadId: childThreadId, input: "Update the issue." });
          worker.emit({
            type: "tool_approval_required",
            toolCallId: "worker-linear",
            toolName: "linear_update",
            args: { issue: "LEO-1", state: "done" },
          } as AgentControllerEvent);
          yield* Effect.yieldNow;

          expect(worker.session.respondToToolApproval).toHaveBeenCalledWith({
            toolCallId: "worker-linear",
            decision: "decline",
            declineContext: expect.objectContaining({
              message: expect.stringContaining("linear_update"),
            }),
          });
          expect(mastra.session.respondToToolApproval).not.toHaveBeenCalled();
          expect(events.filter((event) => event.type === "request.opened")).toEqual([]);
          yield* Fiber.interrupt(eventsFiber);
        }),
        bridge.service,
        mastra.factory,
        () => mcpManager as never,
      );
    });
  });
});

describe("AgentControllerLive", () => {
  describe("temporary workers", () => {
    it.effect("keeps worker limits and declines approvals in a worker chat after a restart", () => {
      const bridge = makeBridge();
      const mastra = mastraHarnessFixture();

      const mcpManager = {
        init: vi.fn(async () => undefined),
        disconnect: vi.fn(async () => undefined),
        getTools: vi.fn(() => ({ linear_update: { mcp: { annotations: {} } } })),
        getServerStatuses: vi.fn(() => []),
      };

      // The worker runtime has no record of this chat, as after a server restart.
      const orphanThreadId = ThreadId.make("worker-thread-orphaned");

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

          // Without a parent link to rebuild the grant from, the chat keeps no tools.
          for (const toolId of [
            "Read",
            "Task",
            "request_box_help",
            "ReactToMessage",
            "ExternalShell",
          ]) {
            expect(tools).not.toContain(toolId);
          }

          yield* controller.sendTurn({ threadId: orphanThreadId, input: "Update the issue." });
          mastra.emit({
            type: "tool_approval_required",
            toolCallId: "orphan-linear",
            toolName: "linear_update",
            args: { issue: "LEO-1", state: "done" },
          } as AgentControllerEvent);
          yield* Effect.yieldNow;

          expect(mastra.session.respondToToolApproval).toHaveBeenCalledWith({
            toolCallId: "orphan-linear",
            decision: "decline",
            declineContext: expect.objectContaining({
              message: expect.stringContaining("linear_update"),
            }),
          });
        }),
        bridge.service,
        mastra.factory,
        () => mcpManager as never,
      );
    });
  });
});

describe("AgentControllerLive", () => {
  describe("temporary workers", () => {
    it.effect("removes the hidden worker chat when its first turn is rejected", () => {
      const bridge = makeBridge();
      const mastra = mastraHarnessFixture();
      const dispatched: OrchestrationCommand[] = [];

      return provideController(
        Effect.gen(function* () {
          const controller = yield* AgentController;
          yield* controller.configureDelegation!({
            readSnapshot: async () => groupParentSnapshot,
            dispatch: async (command) => {
              dispatched.push(command);

              if (command.type === "thread.turn.start") {
                throw new Error("A person member must send turns to this group.");
              }

              return { sequence: dispatched.length };
            },
          });
          yield* resolveCodex(controller);
          yield* controller.startSession(codexThreadId, {
            threadId: codexThreadId,
            provider: ProviderDriverKind.make("codex"),
            providerInstanceId: codexInstanceId,
            cwd: process.cwd(),
            modelSelection: codexSelection,
            runtimeMode: "approval-required",
            botId: bossBotId,
            botName: "Boss",
          });
          yield* controller.sendTurn({ threadId: codexThreadId, input: "Split this up." });

          const runtime = mastra.harnessOptions[0]?.toolRuntime;
          assert.isDefined(runtime);

          const status = (yield* Effect.promise(() =>
            runtime.execute({
              threadId: String(codexThreadId),
              toolId: "Task",
              toolCallId: "task-rejected",
              input: { task: "Never starts" },
              approvalMode: "require-grant",
            }),
          )) as { readonly phase: { readonly _tag: string; readonly failureCode?: string } };

          expect(status.phase).toMatchObject({ _tag: "Failed", failureCode: "internal" });
          // Foreground Task settles only after the discard ran.
          const [create, start, discard] = dispatched;
          expect(create).toMatchObject({ type: "thread.create" });
          expect(start).toMatchObject({ type: "thread.turn.start" });
          expect(discard).toMatchObject({
            type: "thread.delete",
            threadId: create?.type === "thread.create" ? create.threadId : undefined,
          });
        }),
        bridge.service,
        mastra.factory,
      );
    });
  });
});
