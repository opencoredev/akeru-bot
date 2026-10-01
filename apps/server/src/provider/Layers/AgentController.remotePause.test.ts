import * as Predicate from "effect/Predicate";
// @effect-diagnostics globalDate:off globalFetch:off globalFetchInEffect:off nodeBuiltinImport:off preferSchemaOverJson:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { LocalFilesystem, LocalSandbox, Workspace } from "@mastra/core/workspace";
import {
  AkeruMemoryTenantId,
  AkeruMemoryUserId,
  BotId,
  EventId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProjectId,
  ThreadId,
  TurnId,
  type ProviderRuntimeEvent,
} from "@akeru/contracts";
import { it } from "@effect/vitest";
import * as TestClock from "effect/testing/TestClock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { assert, describe, expect, vi } from "vite-plus/test";
import { ServerConfig } from "../../config.ts";
import { BotMemoryStore } from "../../memory/BotMemory.ts";
import { AgentController } from "../Services/AgentController.ts";
import { LegacyProviderBridge } from "../Services/LegacyProviderBridge.ts";
import { agentControllerLayerWith, type AgentControllerLiveOptions } from "./AgentController.ts";
import { BotUsageLedger } from "../../usage/BotUsageLedger.ts";
import {
  codexThreadId,
  claudeThreadId,
  openCodeGoThreadId,
  codexInstanceId,
  openCodeInstanceId,
  openCodeGoInstanceId,
  codexSelection,
} from "./test-support/agentControllerFixtures.ts";
import {
  makeBridge,
  provideController,
  resolveCodex,
} from "./test-support/agentControllerLayers.ts";
import { usageLedgerFixture } from "./test-support/agentControllerMemory.ts";
import { mastraHarnessFixture } from "./test-support/agentControllerHarness.ts";

describe("AgentControllerLive", () => {
  it.effect("retries failed remote pauses in the background without a new session", () => {
    const bridge = makeBridge();
    const mastra = mastraHarnessFixture();

    const workspace = new Workspace({
      filesystem: new LocalFilesystem({ basePath: process.cwd() }),
      sandbox: new LocalSandbox({ workingDirectory: process.cwd() }),
    });

    let paused!: () => void;

    const pauseRetried = new Promise<void>((resolve) => {
      paused = resolve;
    });

    const sleep = vi
      .fn()
      .mockRejectedValueOnce(new Error("pause unavailable"))
      .mockImplementation(async () => {
        paused();
      });

    const destroy = vi.fn(async () => undefined);

    const layer = agentControllerLayerWith({
      makeMastraHarness: mastra.factory,
      makeRemoteWorkspace: async () => ({
        id: "tenki-retry",
        provider: "tenki",
        workspace,
        inspect: async () => "running",
        wake: async () => undefined,
        sleep,
        destroy,
      }),
    }).pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(LegacyProviderBridge, bridge.service),
          Layer.succeed(BotUsageLedger, usageLedgerFixture().service),
          ServerConfig.layerTest(process.cwd(), { prefix: "akeru-pause-retry-" }).pipe(
            Layer.provide(NodeServices.layer),
          ),
        ),
      ),
    );

    return Effect.gen(function* () {
      const controller = yield* AgentController;
      yield* resolveCodex(controller);
      yield* controller.startSession(codexThreadId, {
        threadId: codexThreadId,
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: codexInstanceId,
        modelSelection: codexSelection,
        runtimeMode: "full-access",
        botSandbox: "tenki",
      });
      yield* controller.stopSession({ threadId: codexThreadId }).pipe(Effect.ignore);
      expect(sleep).toHaveBeenCalledOnce();
      yield* TestClock.adjust("30 seconds");
      yield* Effect.promise(() => pauseRetried);
      expect(sleep).toHaveBeenCalledTimes(2);
      expect(destroy).not.toHaveBeenCalled();
    }).pipe(Effect.provide(layer.pipe(Layer.provideMerge(NodeServices.layer))), Effect.orDie);
  });
});

describe("AgentControllerLive", () => {
  it.effect("reuses the remote workspace when only cwd changes", () => {
    const bridge = makeBridge();
    const mastra = mastraHarnessFixture();

    const remote = new Workspace({
      filesystem: new LocalFilesystem({ basePath: process.cwd() }),
      sandbox: new LocalSandbox({ workingDirectory: process.cwd() }),
    });

    const destroy = vi.spyOn(remote, "destroy");

    const makeRemoteWorkspace = vi.fn<
      NonNullable<AgentControllerLiveOptions["makeRemoteWorkspace"]>
    >(async () => remote);

    const makeBotBrowser = vi.fn(() => ({
      tools: {},
      attachment: vi.fn(async () => undefined),
      reconnect: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
    }));

    const layer = agentControllerLayerWith({
      makeMastraHarness: mastra.factory,
      makeRemoteWorkspace,
      makeBotBrowser: makeBotBrowser as never,
    }).pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(LegacyProviderBridge, bridge.service),
          Layer.succeed(BotUsageLedger, usageLedgerFixture().service),
          ServerConfig.layerTest(process.cwd(), {
            prefix: "akeru-mastra-same-workspace-test-",
          }).pipe(Layer.provide(NodeServices.layer)),
        ),
      ),
    );

    return Effect.gen(function* () {
      const controller = yield* AgentController;
      yield* resolveCodex(controller);

      const input = {
        threadId: codexThreadId,
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: codexInstanceId,
        modelSelection: codexSelection,
        runtimeMode: "full-access" as const,
        botSandbox: "upstash" as const,
      };

      yield* controller.startSession(codexThreadId, { ...input, cwd: process.cwd() });
      yield* controller.startSession(codexThreadId, { ...input, cwd: NodeOS.tmpdir() });

      expect(makeRemoteWorkspace).toHaveBeenCalledOnce();
      expect(mastra.createSession).toHaveBeenCalledOnce();
      expect(mastra.createSession.mock.calls[0]?.[0]).toMatchObject({ workspace: remote });
      expect(destroy).not.toHaveBeenCalled();
      expect(makeBotBrowser).toHaveBeenCalledOnce();
    }).pipe(Effect.provide(layer.pipe(Layer.provideMerge(NodeServices.layer))), Effect.orDie);
  });
});

describe("AgentControllerLive", () => {
  it.effect("adds finished child work to only the next Mastra turn", () => {
    const bridge = makeBridge();
    const mastra = mastraHarnessFixture();

    const results =
      "<delegated-work-results>\n- Researcher completed: 42\n</delegated-work-results>";

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
        yield* controller.sendTurn({
          threadId: codexThreadId,
          input: "What did the researcher find?",
          delegationResults: results,
        });
        yield* Effect.promise(() => mastra.waitForSendMessageCount(1));
        expect(mastra.session.state.get().persistentMemoryContext).toBe(results);
        expect(mastra.sendMessage).toHaveBeenCalledWith({
          content: "What did the researcher find?",
        });

        // The next turn queues behind the first and starts once it settles.
        yield* controller.sendTurn({ threadId: codexThreadId, input: "Anything else?" });
        mastra.finishSend();
        yield* Effect.promise(() => mastra.waitForSendMessageCount(2));
        expect(mastra.session.state.get()).not.toHaveProperty("persistentMemoryContext");
        mastra.finishSend();
      }),
      bridge.service,
      mastra.factory,
    );
  });
});

describe("AgentControllerLive", () => {
  it.effect("adds finished child work to legacy turns for every legacy provider", () => {
    const bridge = makeBridge();
    const mastra = mastraHarnessFixture();

    const results =
      "<delegated-work-results>\n- Researcher completed: 42\n</delegated-work-results>";

    return provideController(
      Effect.gen(function* () {
        const controller = yield* AgentController;
        // Claude and Grok on the legacy bridge read context only at session
        // start, so the turn text carries it.
        const threadId = ThreadId.make("thread-legacy-delegation");
        const instanceId = ProviderInstanceId.make("legacyCustom");
        const selection = { instanceId, model: "legacy-model" };
        yield* controller.resolveEngine({
          threadId,
          engine: null,
          fallback: selection,
          mode: "default",
          botConversation: false,
        });
        yield* controller.startSession(threadId, {
          threadId,
          provider: ProviderDriverKind.make("legacyCustom"),
          providerInstanceId: instanceId,
          modelSelection: selection,
          runtimeMode: "full-access",
        });
        yield* controller.sendTurn({
          threadId,
          input: "Summarize it.",
          delegationResults: results,
        });
        const legacyInput = bridge.sendTurn.mock.calls[0]?.[0];
        expect(legacyInput?.input).toBe(`${results}\n\nSummarize it.`);
        expect(legacyInput).not.toHaveProperty("delegationResults");

        // OpenCode reads per-turn context as its system prompt.
        yield* controller.resolveEngine({
          threadId: claudeThreadId,
          engine: { provider: "opencode", model: "anthropic/claude-sonnet-4-5" },
          fallback: codexSelection,
          mode: "default",
          botConversation: false,
        });
        yield* controller.startSession(claudeThreadId, {
          threadId: claudeThreadId,
          provider: ProviderDriverKind.make("opencode"),
          providerInstanceId: openCodeInstanceId,
          cwd: process.cwd(),
          runtimeMode: "approval-required",
        });
        yield* controller.sendTurn({
          threadId: claudeThreadId,
          input: "Summarize it.",
          delegationResults: results,
        });
        const openCodeInput = bridge.sendTurn.mock.calls[1]?.[0];
        expect(openCodeInput?.input).toBe("Summarize it.");
        expect(openCodeInput?.persistentMemoryContext).toContain(results);
        expect(openCodeInput).not.toHaveProperty("delegationResults");
      }),
      bridge.service,
      mastra.factory,
    );
  });
});

describe("AgentControllerLive", () => {
  it.effect("adds compact personality instructions to legacy bot turns", () => {
    const bridge = makeBridge();
    const mastra = mastraHarnessFixture();

    return provideController(
      Effect.gen(function* () {
        const controller = yield* AgentController;
        const threadId = ThreadId.make("thread-legacy-personality");
        const instanceId = ProviderInstanceId.make("legacyCustom");
        const selection = { instanceId, model: "legacy-model" };
        yield* controller.resolveEngine({
          threadId,
          engine: null,
          fallback: selection,
          mode: "default",
          botConversation: true,
        });
        yield* controller.startSession(threadId, {
          threadId,
          provider: ProviderDriverKind.make("legacyCustom"),
          providerInstanceId: instanceId,
          modelSelection: selection,
          runtimeMode: "full-access",
          botId: BotId.make("bot-grok"),
          botName: "Mina",
          personalityTone: 20,
        });
        yield* controller.resolveEngine({
          threadId,
          engine: null,
          fallback: selection,
          mode: "default",
          botConversation: true,
        });
        yield* controller.sendTurn({ threadId, input: "hey what's up" });

        expect(bridge.sendTurn).toHaveBeenCalledWith(
          expect.objectContaining({
            input: expect.stringContaining("20/100, a 80% chill and 20% professional blend"),
          }),
        );
        expect(bridge.sendTurn.mock.calls[0]?.[0].input).toContain("hey what's up");
      }),
      bridge.service,
      mastra.factory,
    );
  });
});

describe("AgentControllerLive", () => {
  it.effect.each(["failed", "interrupted", "cancelled", "aborted"] as const)(
    "keeps a legacy review due after terminal %s",
    (terminalState) => {
      const bridge = makeBridge();
      const mastra = mastraHarnessFixture();
      const memoryDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "akeru-review-failed-"));
      const botMemoryStore = new BotMemoryStore(memoryDir);
      const botId = BotId.make(`bot-legacy-${terminalState}`);

      const memoryAccess = {
        tenantId: AkeruMemoryTenantId.make("local"),
        userId: AkeruMemoryUserId.make("owner"),
        threadId: claudeThreadId,
        projectId: ProjectId.make("project-legacy-failure"),
        workspaceRoot: "/workspace/legacy-failure",
        botId,
        groupId: null,
        respondingBotId: botId,
        groupMemberBotIds: [],
      } as const;

      const event: ProviderRuntimeEvent =
        terminalState === "aborted"
          ? {
              provider: ProviderDriverKind.make("opencode"),
              providerInstanceId: openCodeInstanceId,
              threadId: claudeThreadId,
              turnId: TurnId.make("legacy-turn"),
              type: "turn.aborted",
              eventId: EventId.make("legacy-review-aborted"),
              createdAt: "2026-09-14T12:00:00.000Z",
              payload: { reason: "Provider aborted the turn." },
            }
          : {
              provider: ProviderDriverKind.make("opencode"),
              providerInstanceId: openCodeInstanceId,
              threadId: claudeThreadId,
              turnId: TurnId.make("legacy-turn"),
              type: "turn.completed",
              eventId: EventId.make(`legacy-review-${terminalState}`),
              createdAt: "2026-09-14T12:00:00.000Z",
              payload: { state: terminalState, stopReason: null },
            };

      const service = { ...bridge.service, streamEvents: Stream.succeed(event) };

      return provideController(
        Effect.gen(function* () {
          for (let prompt = 1; prompt <= 10; prompt += 1) {
            const reservation = yield* Effect.promise(() =>
              botMemoryStore.reserveReviewCadence(botId),
            );

            yield* Effect.promise(() => botMemoryStore.settleReviewCadence(reservation, true));
          }

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
            memoryAccess,
          });
          yield* controller.sendTurn({ threadId: claudeThreadId, input: "Threshold prompt" });
          yield* controller.streamEvents.pipe(Stream.take(1), Stream.runDrain);

          assert.deepEqual(yield* Effect.promise(() => botMemoryStore.readReviewCadence(botId)), {
            acceptedPromptCount: 10,
            reviewedThroughPromptCount: 0,
            dueOnNextAcceptedPrompt: true,
          });
        }),
        service,
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
    },
  );
});

describe("AgentControllerLive", () => {
  it.effect("rejects an OpenCode Go turn after the provider is disabled", () => {
    const bridge = makeBridge();
    const mastra = mastraHarnessFixture();

    return provideController(
      Effect.gen(function* () {
        const controller = yield* AgentController;
        yield* controller.resolveEngine({
          threadId: openCodeGoThreadId,
          engine: { provider: String(openCodeGoInstanceId), model: "gpt-5.6-luna" },
          fallback: codexSelection,
          mode: "default",
          botConversation: true,
        });
        yield* controller.startSession(openCodeGoThreadId, {
          threadId: openCodeGoThreadId,
          provider: ProviderDriverKind.make("opencodeGo"),
          providerInstanceId: openCodeGoInstanceId,
          cwd: process.cwd(),
          modelSelection: { instanceId: openCodeGoInstanceId, model: "gpt-5.6-luna" },
          runtimeMode: "approval-required",
        });

        bridge.setInstanceEnabled(false);

        const error = yield* controller
          .sendTurn({ threadId: openCodeGoThreadId, input: "Do not run this turn." })
          .pipe(Effect.flip);

        assert.equal(error._tag, "ProviderValidationError");

        if (Predicate.isTagged(error, "ProviderValidationError")) {
          assert.include(error.issue, "disabled in Akeru Bot settings");
        }

        expect(mastra.sendMessage).not.toHaveBeenCalled();
      }),
      bridge.service,
      mastra.factory,
    );
  });
});

describe("AgentControllerLive", () => {
  it.effect("rejects an OpenCode Go turn disabled during dispatch admission", () => {
    const bridge = makeBridge();
    const mastra = mastraHarnessFixture();

    return provideController(
      Effect.gen(function* () {
        const controller = yield* AgentController;
        yield* controller.resolveEngine({
          threadId: openCodeGoThreadId,
          engine: { provider: String(openCodeGoInstanceId), model: "gpt-5.6-luna" },
          fallback: codexSelection,
          mode: "default",
          botConversation: true,
        });
        yield* controller.startSession(openCodeGoThreadId, {
          threadId: openCodeGoThreadId,
          provider: ProviderDriverKind.make("opencodeGo"),
          providerInstanceId: openCodeGoInstanceId,
          cwd: process.cwd(),
          modelSelection: { instanceId: openCodeGoInstanceId, model: "gpt-5.6-luna" },
          runtimeMode: "approval-required",
        });

        bridge.disableBeforeNextDispatchAdmission();

        const error = yield* controller
          .sendTurn({ threadId: openCodeGoThreadId, input: "Do not dispatch this turn." })
          .pipe(Effect.flip);

        assert.equal(error._tag, "ProviderValidationError");
        expect(mastra.sendMessage).not.toHaveBeenCalled();
      }),
      bridge.service,
      mastra.factory,
    );
  });
});

describe("AgentControllerLive", () => {
  it.effect("applies saved Codex options to initial and active Mastra sessions", () => {
    const bridge = makeBridge();
    const mastra = mastraHarnessFixture();

    return provideController(
      Effect.gen(function* () {
        const controller = yield* AgentController;
        yield* controller.resolveEngine({
          threadId: codexThreadId,
          engine: {
            provider: "codex",
            model: "gpt-5.6-sol",
            options: [
              { id: "reasoningEffort", value: "high" },
              { id: "serviceTier", value: "priority" },
            ],
          },
          fallback: codexSelection,
          mode: "default",
          botConversation: true,
        });
        yield* controller.startSession(codexThreadId, {
          threadId: codexThreadId,
          provider: ProviderDriverKind.make("codex"),
          providerInstanceId: codexInstanceId,
          cwd: process.cwd(),
          runtimeMode: "approval-required",
        });

        expect(mastra.session.state.set).toHaveBeenLastCalledWith(
          expect.objectContaining({
            modelOptions: { reasoningEffort: "high", serviceTier: "priority" },
          }),
        );

        yield* controller.resolveEngine({
          threadId: codexThreadId,
          engine: {
            provider: "codex",
            model: "gpt-5.6-sol",
            options: [
              { id: "reasoningEffort", value: "low" },
              { id: "serviceTier", value: "flex" },
            ],
          },
          fallback: codexSelection,
          mode: "default",
          botConversation: true,
        });

        expect(mastra.session.state.set).toHaveBeenLastCalledWith(
          expect.objectContaining({
            modelOptions: { reasoningEffort: "low", serviceTier: "flex" },
          }),
        );
      }),
      bridge.service,
      mastra.factory,
    );
  });
});

describe("AgentControllerLive", () => {
  it.effect("does not fall back to the legacy Codex loop when its Mastra session is absent", () => {
    const bridge = makeBridge();
    const mastra = mastraHarnessFixture();

    return provideController(
      Effect.gen(function* () {
        const controller = yield* AgentController;
        yield* resolveCodex(controller);

        const error = yield* controller
          .sendTurn({ threadId: codexThreadId, input: "No legacy fallback." })
          .pipe(Effect.flip);

        assert.equal(error._tag, "AgentControllerRuntimeError");
        expect(bridge.sendTurn).not.toHaveBeenCalled();
      }),
      bridge.service,
      mastra.factory,
    );
  });
});
