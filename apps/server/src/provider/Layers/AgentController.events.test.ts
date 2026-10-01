// @effect-diagnostics globalDate:off globalFetch:off globalFetchInEffect:off nodeBuiltinImport:off preferSchemaOverJson:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import type { AgentControllerEvent } from "@mastra/core/agent-controller";
import {
  BotId,
  EventId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type ProviderRuntimeEvent,
} from "@akeru/contracts";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import { assert, describe, expect } from "vite-plus/test";
import { AgentController } from "../Services/AgentController.ts";
import { delegatedUsageReceipt, recordProviderAccessHealth } from "./AgentController.ts";
import { makeTestSubscriptionAuthService } from "../../subscription-auth/testUtils/subscriptionAuthService.ts";
import {
  codexThreadId,
  codexInstanceId,
  codexSelection,
} from "./test-support/agentControllerFixtures.ts";
import {
  makeBridge,
  provideController,
  resolveCodex,
} from "./test-support/agentControllerLayers.ts";
import { makeMastraHarness } from "./test-support/agentControllerHarness.ts";

describe("provider access health", () => {
  it("records a failed first request and recovery at the runtime event boundary", async () => {
    const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "akeru-access-health-"));
    const authPath = NodePath.join(directory, "subscription-auth.json");

    try {
      NodeFS.writeFileSync(
        authPath,
        JSON.stringify({
          xai: { type: "oauth", access: "a", refresh: "r", expires: 1_900_000_000_000 },
        }),
      );
      const service = await makeTestSubscriptionAuthService(authPath);

      const base = {
        provider: ProviderDriverKind.make("grok"),
        providerInstanceId: ProviderInstanceId.make("grok"),
        threadId: ThreadId.make("thread-health"),
      };

      recordProviderAccessHealth(service, {
        ...base,
        type: "runtime.error",
        eventId: EventId.make("evt-health-failed"),
        createdAt: "2026-08-30T20:00:00.000Z",
        payload: { message: "The first request failed.", class: "provider_error" },
      });
      expect(
        service.statuses([], 1_800_000_000_000).find((item) => item.provider === "xai")?.health,
      ).toBe("failed-first-request");
      expect(service.providerInstanceHealth("grok")).toBe("failed-first-request");

      recordProviderAccessHealth(service, {
        ...base,
        type: "turn.completed",
        eventId: EventId.make("evt-health-recovered"),
        createdAt: "2026-08-30T20:01:00.000Z",
        turnId: TurnId.make("turn-health"),
        payload: { state: "completed", stopReason: null },
      });
      expect(
        service.statuses([], 1_800_000_000_000).find((item) => item.provider === "xai")?.health,
      ).toBe("recovered");
      expect(service.providerInstanceHealth("grok")).toBe("recovered");
    } finally {
      NodeFS.rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("AgentControllerLive", () => {
  it("bills delegated usage receipts to the child bot", () => {
    const childBotId = BotId.make("bot-child");
    const childThreadId = ThreadId.make("thread-child");
    const childTurnId = TurnId.make("turn-child");

    const receipt = delegatedUsageReceipt(
      {
        botId: childBotId,
        threadId: childThreadId,
        turnId: childTurnId,
        category: "delegated",
        inputTokens: 12,
        outputTokens: 8,
      },
      { provider: ProviderDriverKind.make("codex"), providerInstanceId: codexInstanceId },
      "2026-01-01T00:00:00.000Z",
    );

    expect(receipt).toMatchObject({
      type: "tool.receipt",
      threadId: childThreadId,
      turnId: childTurnId,
      payload: {
        toolId: "SendToAgent",
        threadId: childThreadId,
        botId: childBotId,
        billedBotId: childBotId,
        fatalToThread: false,
        usage: { inputTokens: 12, outputTokens: 8 },
      },
    });
  });
});

describe("AgentControllerLive", () => {
  it.effect("adds every Mastra step usage update", () => {
    const bridge = makeBridge();
    const mastra = makeMastraHarness();

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
        const events: ProviderRuntimeEvent[] = [];

        const eventsFiber = yield* controller.streamEvents.pipe(
          Stream.runForEach((event) => Effect.sync(() => events.push(event))),
          Effect.forkChild({ startImmediately: true }),
        );

        yield* Effect.yieldNow;
        yield* controller.sendTurn({ threadId: codexThreadId, input: "Use two steps." });
        mastra.emit({
          type: "usage_update",
          usage: { promptTokens: 10, completionTokens: 4, reasoningTokens: 2, totalTokens: 14 },
        } as AgentControllerEvent);
        mastra.emit({
          type: "usage_update",
          usage: { promptTokens: 7, completionTokens: 3, reasoningTokens: 1, totalTokens: 10 },
        } as AgentControllerEvent);
        yield* Effect.yieldNow;
        yield* Fiber.interrupt(eventsFiber);

        assert.deepEqual(
          events.flatMap((event) =>
            event.type === "thread.token-usage.updated" ? [event.payload.usage] : [],
          ),
          [
            { usedTokens: 14, inputTokens: 10, outputTokens: 4, reasoningOutputTokens: 2 },
            { usedTokens: 24, inputTokens: 17, outputTokens: 7, reasoningOutputTokens: 3 },
          ],
        );
        mastra.finishSend();
      }),
      bridge.service,
      mastra.factory,
    );
  });
});

describe("AgentControllerLive", () => {
  it.effect("adds every Mastra step usage update", () => {
    const bridge = makeBridge();
    const mastra = makeMastraHarness();

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
        const events: ProviderRuntimeEvent[] = [];

        const eventsFiber = yield* controller.streamEvents.pipe(
          Stream.runForEach((event) => Effect.sync(() => events.push(event))),
          Effect.forkChild({ startImmediately: true }),
        );

        yield* Effect.yieldNow;
        yield* controller.sendTurn({ threadId: codexThreadId, input: "Use two steps." });
        mastra.emit({
          type: "usage_update",
          usage: { promptTokens: 10, completionTokens: 4, reasoningTokens: 2, totalTokens: 14 },
        } as AgentControllerEvent);
        mastra.emit({
          type: "usage_update",
          usage: { promptTokens: 7, completionTokens: 3, reasoningTokens: 1, totalTokens: 10 },
        } as AgentControllerEvent);
        yield* Effect.yieldNow;
        yield* Fiber.interrupt(eventsFiber);

        assert.deepEqual(
          events.flatMap((event) =>
            event.type === "thread.token-usage.updated" ? [event.payload.usage] : [],
          ),
          [
            { usedTokens: 14, inputTokens: 10, outputTokens: 4, reasoningOutputTokens: 2 },
            { usedTokens: 24, inputTokens: 17, outputTokens: 7, reasoningOutputTokens: 3 },
          ],
        );
        mastra.finishSend();
      }),
      bridge.service,
      mastra.factory,
    );
  });
});
