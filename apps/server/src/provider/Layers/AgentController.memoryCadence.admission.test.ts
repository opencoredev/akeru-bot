import {
  projectionQueryFixture,
  providerRuntimeContext,
} from "./test-support/projectionFixtures.ts";
// @effect-diagnostics globalDate:off globalFetch:off globalFetchInEffect:off nodeBuiltinImport:off preferSchemaOverJson:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import {
  AkeruMemoryTenantId,
  AkeruMemoryUserId,
  BotId,
  EventId,
  GroupId,
  ProviderDriverKind,
  ProjectId,
  ThreadId,
  TurnId,
  type ProviderRuntimeEvent,
} from "@akeru/contracts";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { assert, describe, expect, vi } from "vite-plus/test";
import { BotMemoryStore } from "../../memory/BotMemory.ts";
import { createBotMemoryToolHandler } from "../../memory/BotMemoryToolHandlers.ts";
import * as McpMemoryToolSession from "../../mcp/McpMemoryToolSession.ts";
import { AgentController } from "../Services/AgentController.ts";
import * as ProjectionSnapshotQuery from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { BotUsageCapExceeded } from "../../usage/BotUsageLedger.ts";
import {
  codexThreadId,
  claudeThreadId,
  codexInstanceId,
  openCodeInstanceId,
  codexSelection,
} from "./test-support/agentControllerFixtures.ts";
import {
  completeLegacyTurnWithMemoryReview,
  makeMemoryOnlyCredentialOptions,
  makeUsageLedger,
} from "./test-support/agentControllerMemory.ts";
import {
  makeBridge,
  provideController,
  resolveCodex,
} from "./test-support/agentControllerLayers.ts";
import { makeMastraHarness } from "./test-support/agentControllerHarness.ts";

describe("AgentControllerLive", () => {
  it.effect("releases a Mastra cadence reservation when admission is interrupted", () => {
    vi.useFakeTimers();
    const bridge = makeBridge();
    const mastra = makeMastraHarness();
    const memoryDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "akeru-review-interrupt-"));
    const botMemoryStore = new BotMemoryStore(memoryDir);
    const botId = BotId.make("bot-review-interrupt");
    const renew = vi.spyOn(botMemoryStore, "renewReviewClaim");
    const reservationReached = Promise.withResolvers<void>();
    const reserve = botMemoryStore.reserveReviewCadence.bind(botMemoryStore);
    vi.spyOn(botMemoryStore, "reserveReviewCadence").mockImplementation(async (reservedBotId) => {
      const reservation = await reserve(reservedBotId);
      reservationReached.resolve();

      return reservation;
    });

    return provideController(
      Effect.gen(function* () {
        for (let prompt = 1; prompt <= 10; prompt += 1) {
          const reservation = yield* Effect.promise(() =>
            botMemoryStore.reserveReviewCadence(botId),
          );

          yield* Effect.promise(() => botMemoryStore.settleReviewCadence(reservation, true));
        }

        const controller = yield* AgentController;
        yield* resolveCodex(controller);
        yield* controller.startSession(codexThreadId, {
          threadId: codexThreadId,
          provider: ProviderDriverKind.make("codex"),
          providerInstanceId: codexInstanceId,
          modelSelection: codexSelection,
          runtimeMode: "full-access",
          memoryAccess: {
            tenantId: AkeruMemoryTenantId.make("local"),
            userId: AkeruMemoryUserId.make("owner"),
            threadId: codexThreadId,
            projectId: ProjectId.make("project-review-interrupt"),
            workspaceRoot: "/workspace/review-interrupt",
            botId,
            groupId: null,
            respondingBotId: botId,
            groupMemberBotIds: [],
          },
        });
        yield* controller.sendTurn({ threadId: codexThreadId, input: "Interrupt admission." });
        yield* Effect.promise(() => reservationReached.promise);
        yield* controller.interruptTurn({ threadId: codexThreadId });
        yield* Effect.promise(() => vi.advanceTimersByTimeAsync(60_000));
        expect(renew).not.toHaveBeenCalled();

        const anotherStore = new BotMemoryStore(memoryDir);
        const next = yield* Effect.promise(() => anotherStore.reserveReviewCadence(botId));
        yield* Effect.promise(() => anotherStore.settleReviewCadence(next, false));
      }),
      bridge.service,
      mastra.factory,
      undefined,
      undefined,
      undefined,
      { botMemoryStore },
    ).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          vi.useRealTimers();
          NodeFS.rmSync(memoryDir, { recursive: true, force: true });
        }),
      ),
    );
  });
});

describe("AgentControllerLive", () => {
  it.effect.each([0, 1, 2])(
    "settles a Mastra review only after one successful memory call (count: %s)",
    (successfulMemoryCalls) => {
      const bridge = makeBridge();
      const mastra = makeMastraHarness();
      const memoryDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "akeru-mastra-review-"));
      const botMemoryStore = new BotMemoryStore(memoryDir);
      const botId = BotId.make("bot-mastra-review");

      const access = {
        tenantId: AkeruMemoryTenantId.make("local"),
        userId: AkeruMemoryUserId.make("owner"),
        threadId: codexThreadId,
        projectId: ProjectId.make("project-mastra-review"),
        workspaceRoot: "/workspace/mastra-review",
        botId,
        groupId: null,
        respondingBotId: botId,
        groupMemberBotIds: [],
      } as const;

      return provideController(
        Effect.gen(function* () {
          for (let prompt = 1; prompt <= 10; prompt += 1) {
            const reservation = yield* Effect.promise(() =>
              botMemoryStore.reserveReviewCadence(botId),
            );

            yield* Effect.promise(() => botMemoryStore.settleReviewCadence(reservation, true));
          }

          const acceptedRecorded = Promise.withResolvers<void>();
          const settleReviewClaim = botMemoryStore.settleReviewClaim.bind(botMemoryStore);
          vi.spyOn(botMemoryStore, "settleReviewClaim").mockImplementation(async (...args) => {
            const result = await settleReviewClaim(...args);
            acceptedRecorded.resolve();

            return result;
          });
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

          yield* controller.sendTurn({ threadId: codexThreadId, input: "The tenth prompt" });
          yield* Effect.promise(() => mastra.waitForSendMessageCount(1));
          expect(mastra.session.state.set).toHaveBeenLastCalledWith(
            expect.objectContaining({
              persistentMemoryContext: expect.stringContaining("<automatic-memory-review>"),
            }),
          );
          expect(mastra.session.state.set).toHaveBeenLastCalledWith(
            expect.objectContaining({
              persistentMemoryContext: expect.stringContaining(
                "GROUP.md is not available in this chat",
              ),
            }),
          );

          const runtime = mastra.harnessOptions[0]?.toolRuntime;
          assert.isDefined(runtime);

          for (let call = 0; call < successfulMemoryCalls; call += 1) {
            yield* Effect.promise(() =>
              runtime.execute({
                threadId: String(codexThreadId),
                toolId: "memory",
                toolCallId: `automatic-review-no-op-${call}`,
                input: { target: "user", operations: [] },
                approvalMode: "require-grant",
              }),
            );
          }

          mastra.finishSend();
          yield* Effect.promise(() => acceptedRecorded.promise);
          assert.deepEqual(yield* Effect.promise(() => botMemoryStore.readReviewCadence(botId)), {
            acceptedPromptCount: 11,
            reviewedThroughPromptCount: successfulMemoryCalls === 1 ? 10 : 0,
            dueOnNextAcceptedPrompt: successfulMemoryCalls !== 1,
          });
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
    },
  );
});

describe("AgentControllerLive", () => {
  it.effect("stops renewing a Mastra review claim once the turn settles", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    const bridge = makeBridge();
    const mastra = makeMastraHarness();
    const memoryDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "akeru-review-renewal-"));
    const botMemoryStore = new BotMemoryStore(memoryDir);
    const botId = BotId.make("bot-review-renewal");
    const renew = vi.spyOn(botMemoryStore, "renewReviewClaim");

    return provideController(
      Effect.gen(function* () {
        for (let prompt = 1; prompt <= 10; prompt += 1) {
          const reservation = yield* Effect.promise(() =>
            botMemoryStore.reserveReviewCadence(botId),
          );

          yield* Effect.promise(() => botMemoryStore.settleReviewCadence(reservation, true));
        }

        const settled = Promise.withResolvers<void>();
        const settleReviewClaim = botMemoryStore.settleReviewClaim.bind(botMemoryStore);
        vi.spyOn(botMemoryStore, "settleReviewClaim").mockImplementation(async (...args) => {
          const result = await settleReviewClaim(...args);
          settled.resolve();

          return result;
        });
        const controller = yield* AgentController;
        yield* resolveCodex(controller);
        yield* controller.startSession(codexThreadId, {
          threadId: codexThreadId,
          provider: ProviderDriverKind.make("codex"),
          providerInstanceId: codexInstanceId,
          modelSelection: codexSelection,
          runtimeMode: "full-access",
          memoryAccess: {
            tenantId: AkeruMemoryTenantId.make("local"),
            userId: AkeruMemoryUserId.make("owner"),
            threadId: codexThreadId,
            projectId: ProjectId.make("project-review-renewal"),
            workspaceRoot: "/workspace/review-renewal",
            botId,
            groupId: null,
            respondingBotId: botId,
            groupMemberBotIds: [],
          },
        });

        // Effect's scheduler and the lock retry also use timers, so pump fake
        // time until the awaited receipt lands instead of advancing blindly.
        const pumpUntil = async (receipt: Promise<void>) => {
          let landed = false;
          void receipt.then(() => {
            landed = true;
          });

          for (;;) {
            if (landed) break;
            await vi.advanceTimersByTimeAsync(15);
          }
        };

        const secondRenewal = Promise.withResolvers<void>();
        renew.mockImplementation(async (...args) => {
          const result = await BotMemoryStore.prototype.renewReviewClaim.apply(
            botMemoryStore,
            args,
          );

          if (renew.mock.calls.length >= 2) secondRenewal.resolve();

          return result;
        });

        yield* controller.sendTurn({ threadId: codexThreadId, input: "Review this turn." });
        yield* Effect.promise(() => pumpUntil(mastra.waitForSendMessageCount(1)));
        // While the turn runs, the claim is renewed on its 20 second schedule.
        yield* Effect.promise(() => pumpUntil(secondRenewal.promise));

        mastra.finishSend();
        yield* Effect.promise(() => pumpUntil(settled.promise));
        const renewalsBeforeSettlement = renew.mock.calls.length;
        yield* Effect.promise(() => vi.advanceTimersByTimeAsync(120_000));
        expect(renew).toHaveBeenCalledTimes(renewalsBeforeSettlement);
      }),
      bridge.service,
      mastra.factory,
      undefined,
      undefined,
      undefined,
      { botMemoryStore },
    ).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          vi.useRealTimers();
          NodeFS.rmSync(memoryDir, { recursive: true, force: true });
        }),
      ),
    );
  });
});

describe("AgentControllerLive", () => {
  it.effect("records memory usage for an observation drained before its chat reopens", () => {
    const bridge = makeBridge();
    const mastra = makeMastraHarness();
    const usage = makeUsageLedger();
    const botId = BotId.make("bot-recovered-memory");

    return provideController(
      Effect.gen(function* () {
        // No startSession or turn: the durable queue drained after a restart.
        const options = mastra.harnessOptions[0]!;

        const callId = yield* Effect.promise(() =>
          options.startMemoryCall!({ threadId: "thread-recovered", category: "observer" }),
        );

        assert.isDefined(callId);
        yield* Effect.promise(() =>
          Promise.resolve(
            options.finishMemoryCall!({
              callId,
              category: "observer",
              usage: { inputTokens: 120, outputTokens: 30 },
            }),
          ),
        );
        expect(usage.reserve).not.toHaveBeenCalled();
        expect(usage.recordMeasurement).toHaveBeenCalledWith(
          expect.objectContaining({
            reservationId: callId,
            botId,
            threadId: ThreadId.make("thread-recovered"),
            category: "observer",
            inputTokens: 120,
            outputTokens: 30,
          }),
        );
      }),
      bridge.service,
      mastra.factory,
      undefined,
      undefined,
      usage.service,
    ).pipe(
      Effect.provideService(
        ProjectionSnapshotQuery.ProjectionSnapshotQuery,
        ProjectionSnapshotQuery.ProjectionSnapshotQuery.of(
          projectionQueryFixture({
            getThreadRuntimeContext: () =>
              Effect.succeed(Option.some(providerRuntimeContext({ botId }))),
            getBotById: () => Effect.succeed(Option.none()),
            getGroupById: () => Effect.succeed(Option.none()),
            listThreadDelegations: () => Effect.succeed([]),
          }),
        ),
      ),
    );
  });
});

describe("AgentControllerLive", () => {
  it.effect("reserves and settles billed observational-memory usage", () => {
    const bridge = makeBridge();
    const mastra = makeMastraHarness();
    const usageLedger = makeUsageLedger();

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
        const botId = BotId.make("bot-memory");
        yield* controller.sendTurn({
          threadId: codexThreadId,
          input: "Remember this.",
          botUsage: { botId, capLimit: 50_000 },
        });
        const options = mastra.harnessOptions[0]!;

        const callId = yield* Effect.promise(() =>
          options.startMemoryCall!({ threadId: codexThreadId, category: "observer" }),
        );

        assert.isDefined(callId);
        expect(usageLedger.reserve).toHaveBeenCalledWith(
          expect.objectContaining({
            reservationId: callId,
            botId,
            threadId: codexThreadId,
            category: "observer",
            maximumTokens: 32_000,
            capLimit: 50_000,
            provider: "codex",
            model: "gpt-5.6-sol",
          }),
        );

        yield* Effect.promise(() =>
          options.finishMemoryCall!({
            callId: callId!,
            category: "observer",
            usage: { inputTokens: 12, outputTokens: 5, totalTokens: 17 },
          }),
        );
        expect(usageLedger.settle).toHaveBeenCalledWith({
          reservationId: callId,
          state: "reported",
          inputTokens: 12,
          outputTokens: 5,
          reasoningTokens: null,
          settledAt: expect.any(String),
        });

        usageLedger.reserve.mockImplementationOnce(() =>
          Effect.fail(
            new BotUsageCapExceeded({
              botId,
              limit: 50_000,
              consumedTokens: 20_000,
              reservedTokens: 30_000,
              requestedTokens: 32_000,
            }),
          ),
        );
        yield* Effect.promise(() =>
          expect(
            options.startMemoryCall!({ threadId: codexThreadId, category: "reflector" }),
          ).rejects.toBeInstanceOf(BotUsageCapExceeded),
        );
        mastra.finishSend();
      }),
      bridge.service,
      mastra.factory,
      undefined,
      undefined,
      usageLedger.service,
    );
  });
});

describe("AgentControllerLive", () => {
  it.effect.each([0, 1, 2])(
    "settles a legacy foreground review only after one successful memory call (count: %s)",
    (successfulMemoryCalls) => {
      const bridge = makeBridge();
      const mastra = makeMastraHarness();
      const credentials = makeMemoryOnlyCredentialOptions();
      const memoryDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "akeru-review-cadence-"));
      const botMemoryStore = new BotMemoryStore(memoryDir);
      const botId = BotId.make("bot-legacy-review");
      const groupId = GroupId.make("group-legacy-review");

      const memoryAccess = {
        tenantId: AkeruMemoryTenantId.make("local"),
        userId: AkeruMemoryUserId.make("owner"),
        threadId: claudeThreadId,
        projectId: ProjectId.make("project-legacy-review"),
        workspaceRoot: "/workspace/legacy-review",
        botId,
        groupId,
        respondingBotId: botId,
        groupMemberBotIds: [botId],
      } as const;

      const completedEvent: ProviderRuntimeEvent = {
        provider: ProviderDriverKind.make("opencode"),
        providerInstanceId: openCodeInstanceId,
        threadId: claudeThreadId,
        turnId: TurnId.make("legacy-turn"),
        type: "turn.completed",
        eventId: EventId.make("legacy-review-complete"),
        createdAt: "2026-09-14T12:00:00.000Z",
        payload: { state: "completed", stopReason: null },
      };

      bridge.sendTurn.mockImplementation((input) =>
        completeLegacyTurnWithMemoryReview(
          input,
          TurnId.make("legacy-turn"),
          successfulMemoryCalls,
        ),
      );
      const service = { ...bridge.service, streamEvents: Stream.succeed(completedEvent) };

      return provideController(
        Effect.gen(function* () {
          for (let prompt = 1; prompt <= 10; prompt += 1) {
            const reservation = yield* Effect.promise(() =>
              botMemoryStore.reserveReviewCadence(botId, {
                threadId: `group-history-${prompt}`,
                groupId: String(groupId),
                text: `Group prompt ${prompt}`,
              }),
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
            botId,
            botName: "OpenCode Review Bot",
            memoryAccess,
          });
          McpMemoryToolSession.setMcpMemoryToolSession(
            claudeThreadId,
            createBotMemoryToolHandler(botMemoryStore, memoryAccess, new Set(["user", "group"]))
              .memory,
          );

          yield* controller.sendTurn({ threadId: claudeThreadId, input: "Threshold prompt" });
          const context = bridge.sendTurn.mock.calls[0]?.[0].persistentMemoryContext;
          expect(context).toContain("<automatic-memory-review>");
          expect(context).toContain("only your GROUP.md for this active group");
          expect(context).toContain("Never read or change another bot's group memory");
          assert.equal(
            (yield* Effect.promise(() => botMemoryStore.readReviewCadence(botId, String(groupId))))
              .acceptedPromptCount,
            10,
          );

          yield* controller.streamEvents.pipe(Stream.take(1), Stream.runDrain);
          assert.deepEqual(
            yield* Effect.promise(() => botMemoryStore.readReviewCadence(botId, String(groupId))),
            {
              acceptedPromptCount: 11,
              reviewedThroughPromptCount: successfulMemoryCalls === 1 ? 10 : 0,
              dueOnNextAcceptedPrompt: successfulMemoryCalls !== 1,
            },
          );
        }),
        service,
        mastra.factory,
        undefined,
        undefined,
        undefined,
        { botMemoryStore, ...credentials },
      ).pipe(
        Effect.ensuring(
          Effect.sync(() => NodeFS.rmSync(memoryDir, { recursive: true, force: true })),
        ),
      );
    },
  );
});
