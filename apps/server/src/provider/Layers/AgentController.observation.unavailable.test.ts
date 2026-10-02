import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import {
  DEFAULT_SERVER_SETTINGS,
  AkeruMemoryTenantId,
  AkeruMemoryUserId,
  BotId,
  GroupId,
  ProviderDriverKind,
  ProjectId,
  TurnId,
  type ServerSettings,
} from "@akeru/contracts";
import { it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { assert, describe, expect, vi } from "vite-plus/test";
import { ServerSettingsService } from "../../serverSettings.ts";
import { BotMemoryStore } from "../../memory/BotMemory.ts";
import { AgentController } from "../Services/AgentController.ts";
import * as OrchestrationEngine from "../../orchestration/Services/OrchestrationEngine.ts";
import {
  codexThreadId,
  claudeThreadId,
  codexInstanceId,
  openCodeInstanceId,
  codexSelection,
} from "./test-support/agentControllerFixtures.ts";
import {
  makeBridge,
  makeLayer,
  provideController,
  resolveCodex,
} from "./test-support/agentControllerLayers.ts";
import { makeMemoryOnlyCredentialOptions } from "./test-support/agentControllerMemory.ts";
import { mastraHarnessFixture } from "./test-support/agentControllerHarness.ts";

describe("AgentControllerLive", () => {
  it.effect("rejects conversation memory calls when the harness has no memory", () => {
    const bridge = makeBridge();
    const mastra = mastraHarnessFixture();

    return provideController(
      Effect.gen(function* () {
        const controller = yield* AgentController;

        const readError = yield* controller.readConversationMemory!(codexThreadId).pipe(
          Effect.flip,
        );

        const clearError = yield* controller.clearConversationMemory!(codexThreadId).pipe(
          Effect.flip,
        );

        assert.deepInclude(readError, {
          _tag: "AgentControllerRuntimeError",
          operation: "memory.read",
        });
        assert.deepInclude(clearError, {
          _tag: "AgentControllerRuntimeError",
          operation: "memory.clear",
        });
      }),
      bridge.service,
      mastra.factory,
    );
  });
});

describe("AgentControllerLive", () => {
  it.effect("registers the file-backed memory tool for Mastra sessions", () => {
    const bridge = makeBridge();
    const mastra = mastraHarnessFixture();

    const access = {
      tenantId: AkeruMemoryTenantId.make("local"),
      userId: AkeruMemoryUserId.make("owner"),
      threadId: codexThreadId,
      projectId: ProjectId.make("project-memory-tools"),
      workspaceRoot: "/workspace/memory-tools",
      botId: BotId.make("bot-memory-tools"),
      groupId: null,
      respondingBotId: BotId.make("bot-memory-tools"),
      groupMemberBotIds: [],
    } as const;

    return provideController(
      Effect.gen(function* () {
        const controller = yield* AgentController;
        yield* resolveCodex(controller);
        yield* controller.startSession(codexThreadId, {
          threadId: codexThreadId,
          provider: ProviderDriverKind.make("codex"),
          providerInstanceId: codexInstanceId,
          modelSelection: codexSelection,
          runtimeMode: "full-access",
          memoryAccess: access,
        });

        const runtime = mastra.harnessOptions[0]?.toolRuntime;
        assert.isDefined(runtime);
        expect(runtime.toolsForThread(String(codexThreadId)).map((tool) => tool.id)).toEqual(
          expect.arrayContaining(["memory"]),
        );

        const result = yield* Effect.promise(() =>
          runtime.execute({
            threadId: String(codexThreadId),
            toolId: "memory",
            toolCallId: "private-memory",
            input: {
              target: "user",
              operations: [{ action: "add", content: "The user prefers vim." }],
            },
            approvalMode: "require-grant",
          }),
        );

        expect(result).toMatchObject({ success: true, message: "Memory updated.", target: "user" });

        const recalled = yield* Effect.promise(() =>
          runtime.execute({
            threadId: String(codexThreadId),
            toolId: "memory",
            toolCallId: "read-private-memory",
            input: { target: "user", operations: [] },
            approvalMode: "require-grant",
          }),
        );

        expect(recalled).toMatchObject({
          success: true,
          changed: false,
          content: "The user prefers vim.",
        });
      }),
      bridge.service,
      mastra.factory,
    );
  });
});

describe("AgentControllerLive", () => {
  it.effect("keeps group memory tools bound to the admitted responding bot", () => {
    const bridge = makeBridge();
    const mastra = mastraHarnessFixture();
    const memoryDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "akeru-group-tool-scope-"));
    const botMemoryStore = new BotMemoryStore(memoryDir);
    const botA = BotId.make("bot-group-active-a");
    const botB = BotId.make("bot-group-queued-b");
    const groupId = GroupId.make("group-tool-scope");

    const accessFor = (botId: BotId) =>
      ({
        tenantId: AkeruMemoryTenantId.make("local"),
        userId: AkeruMemoryUserId.make("owner"),
        threadId: codexThreadId,
        projectId: ProjectId.make("project-group-tool-scope"),
        workspaceRoot: "/workspace/group-tool-scope",
        botId,
        groupId,
        respondingBotId: botId,
        groupMemberBotIds: [botA, botB],
      }) as const;

    return provideController(
      Effect.gen(function* () {
        const controller = yield* AgentController;
        yield* resolveCodex(controller);
        yield* Effect.promise(() =>
          botMemoryStore.mutate({
            ...accessFor(botB),
            target: "user",
            operations: [{ action: "add", content: "The user likes coffee." }],
          }),
        );
        yield* controller.startSession(codexThreadId, {
          threadId: codexThreadId,
          provider: ProviderDriverKind.make("codex"),
          providerInstanceId: codexInstanceId,
          modelSelection: codexSelection,
          runtimeMode: "full-access",
          memoryAccess: accessFor(botA),
        });
        yield* controller.sendTurn({ threadId: codexThreadId, input: "Bot A turn." });
        yield* Effect.promise(() => mastra.waitForSendMessageCount(1));

        yield* controller.startSession(codexThreadId, {
          threadId: codexThreadId,
          provider: ProviderDriverKind.make("codex"),
          providerInstanceId: codexInstanceId,
          modelSelection: codexSelection,
          runtimeMode: "full-access",
          memoryAccess: accessFor(botB),
        });
        yield* controller.sendTurn({ threadId: codexThreadId, input: "Bot B queued turn." });

        const runtime = mastra.harnessOptions[0]?.toolRuntime;
        assert.isDefined(runtime);
        yield* Effect.promise(() =>
          runtime.execute({
            threadId: String(codexThreadId),
            toolId: "memory",
            toolCallId: "active-bot-group-memory",
            input: {
              target: "group",
              operations: [{ action: "add", content: "The group chose option A." }],
            },
            approvalMode: "require-grant",
          }),
        );

        const activeDocument = yield* Effect.promise(() =>
          botMemoryStore.readDocument(accessFor(botA), "group"),
        );

        const queuedDocument = yield* Effect.promise(() =>
          botMemoryStore.readDocument(accessFor(botB), "group"),
        );

        expect(activeDocument.content).toContain("The group chose option A.");
        expect(queuedDocument.content).not.toContain("The group chose option A.");

        mastra.finishSend();
        yield* Effect.promise(() => mastra.waitForSendMessageCount(2));
        expect(mastra.session.state.get()).toHaveProperty("persistentMemoryContext");
        yield* controller.startSession(codexThreadId, {
          threadId: codexThreadId,
          provider: ProviderDriverKind.make("codex"),
          providerInstanceId: codexInstanceId,
          modelSelection: codexSelection,
          runtimeMode: "full-access",
        });
        yield* controller.sendTurn({
          threadId: codexThreadId,
          input: "Turn without memory access.",
        });
        mastra.finishSend();
        yield* Effect.promise(() => mastra.waitForSendMessageCount(3));
        expect(mastra.session.state.get()).not.toHaveProperty("persistentMemoryContext");
        expect(runtime.toolsForThread(String(codexThreadId)).map((tool) => tool.id)).not.toContain(
          "memory",
        );
        mastra.finishSend();
      }),
      bridge.service,
      mastra.factory,
      undefined,
      undefined,
      undefined,
      { botMemoryStore },
    ).pipe(
      Effect.ensuring(
        Effect.sync(() => NodeFS.rmSync(memoryDir, { recursive: true, force: true })),
      ),
    );
  });
});

describe("AgentControllerLive", () => {
  it.effect("honors the Memory setting per turn on the Mastra path", () => {
    const bridge = makeBridge();
    const mastra = mastraHarnessFixture();

    const memoryDir = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), "akeru-memory-toggle-mastra-"),
    );

    const botMemoryStore = new BotMemoryStore(memoryDir);
    const botId = BotId.make("bot-memory-toggle-mastra");

    const access = {
      tenantId: AkeruMemoryTenantId.make("local"),
      userId: AkeruMemoryUserId.make("owner"),
      threadId: codexThreadId,
      projectId: ProjectId.make("project-memory-toggle-mastra"),
      workspaceRoot: "/workspace/memory-toggle-mastra",
      botId,
      groupId: null,
      respondingBotId: botId,
      groupMemberBotIds: [],
    } as const;

    return provideController(
      Effect.gen(function* () {
        const controller = yield* AgentController;
        const settings = yield* ServerSettingsService;
        yield* resolveCodex(controller);
        yield* Effect.promise(() =>
          botMemoryStore.mutate({
            ...access,
            target: "user",
            operations: [{ action: "add", content: "The user prefers vim." }],
          }),
        );
        yield* controller.startSession(codexThreadId, {
          threadId: codexThreadId,
          provider: ProviderDriverKind.make("codex"),
          providerInstanceId: codexInstanceId,
          modelSelection: codexSelection,
          runtimeMode: "full-access",
          memoryAccess: access,
        });
        const reserve = vi.spyOn(botMemoryStore, "reserveReviewCadence");
        const readSnapshot = vi.spyOn(botMemoryStore, "readPromptSnapshot");

        // While Memory is on, the admitted turn supplies the durable snapshot.
        yield* controller.sendTurn({ threadId: codexThreadId, input: "Remember this turn." });
        yield* Effect.promise(() => mastra.waitForSendMessageCount(1));
        expect(mastra.session.state.get().persistentMemoryContext).toContain("<user-memory>");
        mastra.finishSend();
        yield* Effect.yieldNow;

        const awaitNextCompletedTurn = () =>
          controller.streamEvents.pipe(
            Stream.filter((event) => event.type === "turn.completed"),
            Stream.runHead,
            Effect.forkChild({ startImmediately: true }),
          );

        // Toggling Memory off mid-session must stop snapshot reads and review
        // reservations for the very next turn, and remove the memory tool.
        yield* settings.updateSettings({ memory: { enabled: false } });
        const offTurn = yield* awaitNextCompletedTurn();
        yield* controller.sendTurn({ threadId: codexThreadId, input: "No memory now." });
        yield* Effect.promise(() => mastra.waitForSendMessageCount(2));
        mastra.finishSend();
        yield* Fiber.join(offTurn);
        expect(readSnapshot).toHaveBeenCalledTimes(1);
        expect(reserve).toHaveBeenCalledTimes(1);
        expect(mastra.session.state.get()).not.toHaveProperty("persistentMemoryContext");
        const runtime = mastra.harnessOptions[0]?.toolRuntime;
        assert.isDefined(runtime);
        expect(runtime.toolsForThread(String(codexThreadId)).map((tool) => tool.id)).not.toContain(
          "memory",
        );

        // Turning Memory back on restores the snapshot on the next turn.
        yield* settings.updateSettings({ memory: { enabled: true } });
        const restoredTurn = yield* awaitNextCompletedTurn();
        yield* controller.sendTurn({ threadId: codexThreadId, input: "Memory again." });
        yield* Effect.promise(() => mastra.waitForSendMessageCount(3));
        expect(mastra.session.state.get().persistentMemoryContext).toContain("<user-memory>");
        mastra.finishSend();
        yield* Fiber.join(restoredTurn);
        expect(readSnapshot).toHaveBeenCalledTimes(2);
        expect(reserve).toHaveBeenCalledTimes(2);
      }),
      bridge.service,
      mastra.factory,
      undefined,
      undefined,
      undefined,
      { botMemoryStore },
    ).pipe(
      Effect.ensuring(
        Effect.sync(() => NodeFS.rmSync(memoryDir, { recursive: true, force: true })),
      ),
    );
  });
});

describe("AgentControllerLive", () => {
  it.effect("keeps group facts out of memory when group membership cannot be rechecked", () => {
    const bridge = makeBridge();
    const mastra = mastraHarnessFixture();
    const botId = BotId.make("bot-entity-memory-stale-group");

    const access = {
      tenantId: AkeruMemoryTenantId.make("local"),
      userId: AkeruMemoryUserId.make("owner"),
      threadId: claudeThreadId,
      projectId: ProjectId.make("project-entity-memory-stale-group"),
      workspaceRoot: "/workspace/entity-memory-stale-group",
      botId,
      groupId: GroupId.make("group-entity-memory-stale"),
      respondingBotId: botId,
      groupMemberBotIds: [botId],
    } as const;

    const listCurrent = vi.fn(
      (_input: { access: { groupId: GroupId | null; groupMemberBotIds: ReadonlyArray<BotId> } }) =>
        Effect.succeed([]),
    );

    const recordDerivedCopies = vi.fn(() => Effect.void);

    return provideController(
      Effect.gen(function* () {
        const controller = yield* AgentController;
        yield* controller.resolveEngine({
          threadId: claudeThreadId,
          engine: { provider: "opencode", model: "anthropic/claude-sonnet-4-5" },
          fallback: codexSelection,
          mode: "default",
          botConversation: true,
        });
        yield* controller.startSession(claudeThreadId, {
          threadId: claudeThreadId,
          provider: ProviderDriverKind.make("opencode"),
          providerInstanceId: openCodeInstanceId,
          cwd: process.cwd(),
          runtimeMode: "approval-required",
          memoryAccess: access,
        });
        // Reads here are the legacy migration; no memory packet reaches the group prompt.
        expect(recordDerivedCopies).not.toHaveBeenCalled();
      }),
      bridge.service,
      mastra.factory,
      undefined,
      undefined,
      undefined,
      {
        ...makeMemoryOnlyCredentialOptions(),
        entityMemoryRepository: { listCurrent, recordDerivedCopies } as never,
      },
    );
  });
});

describe("AgentControllerLive", () => {
  it.effect("drops a Mastra admission interrupted while the memory settings read is held", () => {
    const bridge = makeBridge();
    const mastra = mastraHarnessFixture();

    const memoryDir = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), "akeru-mastra-admit-gate-"),
    );

    const botMemoryStore = new BotMemoryStore(memoryDir);
    const botId = BotId.make("bot-mastra-admit-gate");

    const access = {
      tenantId: AkeruMemoryTenantId.make("local"),
      userId: AkeruMemoryUserId.make("owner"),
      threadId: codexThreadId,
      projectId: ProjectId.make("project-mastra-admit-gate"),
      workspaceRoot: "/workspace/mastra-admit-gate",
      botId,
      groupId: null,
      respondingBotId: botId,
      groupMemberBotIds: [],
    } as const;

    const disabledMemorySettings: ServerSettings = {
      ...DEFAULT_SERVER_SETTINGS,
      memory: { ...DEFAULT_SERVER_SETTINGS.memory, enabled: false },
    };

    const sessionInput = {
      threadId: codexThreadId,
      provider: ProviderDriverKind.make("codex"),
      providerInstanceId: codexInstanceId,
      modelSelection: codexSelection,
      runtimeMode: "full-access" as const,
      memoryAccess: access,
    };

    const gate = Deferred.makeUnsafe<void>();
    const reached = Deferred.makeUnsafe<void>();
    let holdNextGetSettings = false;

    const gatedSettingsLayer = Layer.succeed(ServerSettingsService, {
      start: Effect.void,
      ready: Effect.void,
      getSettings: Effect.suspend(() =>
        holdNextGetSettings
          ? Effect.sync(() => {
              Deferred.doneUnsafe(reached, Effect.void);
            }).pipe(Effect.andThen(Deferred.await(gate)), Effect.as(disabledMemorySettings))
          : Effect.succeed(disabledMemorySettings),
      ),
      updateSettings: () => Effect.die("not used"),
      streamChanges: Stream.empty,
      subscribeChanges: Effect.succeed(Stream.empty),
    });

    return Effect.gen(function* () {
      const controller = yield* AgentController;
      yield* resolveCodex(controller);
      yield* controller.startSession(codexThreadId, sessionInput);
      holdNextGetSettings = true;
      yield* controller.sendTurn({ threadId: codexThreadId, input: "Interrupt me." });
      yield* Deferred.await(reached);

      // Collect turn.started events for the rest of the test so we can prove
      // the cancelled admission never begins a turn.
      const startedEvents: TurnId[] = [];

      const startedFiber = yield* controller.streamEvents.pipe(
        Stream.filter((event) => event.type === "turn.started"),
        Stream.runForEach((event) =>
          Effect.sync(() => {
            if (event.turnId) startedEvents.push(event.turnId);
          }),
        ),
        Effect.forkChild({ startImmediately: true }),
      );

      yield* Effect.yieldNow;
      yield* controller.interruptTurn({ threadId: codexThreadId });

      const next = yield* controller.sendTurn({
        threadId: codexThreadId,
        input: "Replacement turn.",
      });

      // Admission of the replacement is queued behind the held settings read.
      assert.equal(mastra.sendMessage.mock.calls.length, 0);

      Deferred.doneUnsafe(gate, Effect.void);
      yield* Effect.promise(() => mastra.waitForSendMessageCount(1));
      mastra.finishSend();
      yield* Effect.yieldNow;

      // The interrupted admission must never reach sendMessage or displace the
      // replacement turn's state.
      assert.equal(mastra.sendMessage.mock.calls.length, 1);
      expect(mastra.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          content: expect.stringContaining("Replacement turn."),
        }),
      );
      yield* Effect.yieldNow;
      yield* Fiber.interrupt(startedFiber);
      assert.deepEqual(startedEvents, [next.turnId] as TurnId[]);
    }).pipe(
      Effect.provide(
        makeLayer(
          bridge.service,
          mastra.factory,
          undefined,
          undefined,
          undefined,
          { botMemoryStore },
          undefined,
          undefined,
          gatedSettingsLayer,
        ),
      ),
      Effect.orDie,
      Effect.ensuring(
        Effect.sync(() => {
          NodeFS.rmSync(memoryDir, { recursive: true, force: true });
        }),
      ),
    );
  });
});

describe("AgentControllerLive", () => {
  it.effect("dispatches a thread activity when an observation is dropped", () => {
    const bridge = makeBridge();
    const mastra = mastraHarnessFixture();

    const dispatched: Array<{
      readonly type: string;
      readonly commandId?: string;
      readonly activity?: unknown;
    }> = [];

    return provideController(
      Effect.gen(function* () {
        const controller = yield* AgentController;
        yield* resolveCodex(controller);
        yield* controller.startSession(codexThreadId, {
          threadId: codexThreadId,
          provider: ProviderDriverKind.make("codex"),
          providerInstanceId: codexInstanceId,
          modelSelection: codexSelection,
          runtimeMode: "full-access",
        });
        const options = mastra.harnessOptions[0]!;
        yield* Effect.promise(() =>
          Promise.resolve(
            options.onObservationDropped!({
              observationId: "observation-dropped-row",
              threadId: String(codexThreadId),
              turnId: "turn-dropped",
              resourceId: String(codexThreadId),
              modelId: "openai/gpt-5.6-sol",
              attempts: 3,
              error: new Error("observer down"),
            }),
          ),
        );
        assert.equal(dispatched.length, 1);
        const command = dispatched[0]!;
        assert.equal(command.type, "thread.activity.append");

        const activity = command.activity as {
          readonly kind: string;
          readonly tone: string;
          readonly turnId: string;
          readonly payload: { readonly attempts: number };
        };

        assert.equal(activity.kind, "memory.observation.dropped");
        assert.equal(activity.tone, "error");
        assert.equal(activity.turnId, "turn-dropped");
        assert.equal(activity.payload.attempts, 3);
        assert.equal(command.commandId, "server:observation-dropped:observation-dropped-row");
      }),
      bridge.service,
      mastra.factory,
    ).pipe(
      Effect.provideService(
        OrchestrationEngine.OrchestrationEngineService,
        OrchestrationEngine.OrchestrationEngineService.of({
          readEvents: () => Stream.empty,
          readThreadEvents: () => Stream.empty,
          getThreadReplayStats: () => Effect.die("unused"),
          dispatch: (command) =>
            Effect.sync(() => {
              dispatched.push(command);

              return { sequence: 1 };
            }),
          streamDomainEvents: Stream.empty,
          subscribeDomainEvents: Effect.succeed(Stream.empty),
          latestSequence: Effect.succeed(0),
        }),
      ),
    );
  });
});
