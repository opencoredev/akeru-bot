// @effect-diagnostics globalDate:off globalFetch:off globalFetchInEffect:off nodeBuiltinImport:off preferSchemaOverJson:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import {
  AkeruMemoryTenantId,
  AkeruMemoryUserId,
  BotId,
  EventId,
  ProviderDriverKind,
  ProjectId,
  TurnId,
  type ProviderRuntimeEvent,
} from "@akeru/contracts";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { describe, expect, vi } from "vite-plus/test";
import { ServerSettingsService } from "../../serverSettings.ts";
import { BotMemoryStore } from "../../memory/BotMemory.ts";
import * as McpMemoryToolSession from "../../mcp/McpMemoryToolSession.ts";
import { AgentController } from "../Services/AgentController.ts";
import {
  claudeThreadId,
  openCodeInstanceId,
  codexSelection,
} from "./test-support/agentControllerFixtures.ts";
import { makeBridge, provideController } from "./test-support/agentControllerLayers.ts";
import { makeMemoryOnlyCredentialOptions } from "./test-support/agentControllerMemory.ts";
import { makeMastraHarness } from "./test-support/agentControllerHarness.ts";

describe("AgentControllerLive", () => {
  it.effect("honors the Memory setting per turn on the legacy provider path", () => {
    const bridge = makeBridge();
    const mastra = makeMastraHarness();

    const memoryDir = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), "akeru-memory-toggle-legacy-"),
    );

    const botMemoryStore = new BotMemoryStore(memoryDir);
    const botId = BotId.make("bot-memory-toggle-legacy");

    const access = {
      tenantId: AkeruMemoryTenantId.make("local"),
      userId: AkeruMemoryUserId.make("owner"),
      threadId: claudeThreadId,
      projectId: ProjectId.make("project-memory-toggle-legacy"),
      workspaceRoot: "/workspace/memory-toggle-legacy",
      botId,
      groupId: null,
      respondingBotId: botId,
      groupMemberBotIds: [],
    } as const;

    const credentials = makeMemoryOnlyCredentialOptions();

    return provideController(
      Effect.gen(function* () {
        const controller = yield* AgentController;
        const settings = yield* ServerSettingsService;
        yield* controller.resolveEngine({
          threadId: claudeThreadId,
          engine: { provider: "opencode", model: "anthropic/claude-sonnet-4-5" },
          fallback: codexSelection,
          mode: "default",
          botConversation: true,
        });
        yield* Effect.promise(() =>
          botMemoryStore.mutate({
            ...access,
            target: "user",
            operations: [{ action: "add", content: "The user prefers vim." }],
          }),
        );
        yield* controller.startSession(claudeThreadId, {
          threadId: claudeThreadId,
          provider: ProviderDriverKind.make("opencode"),
          providerInstanceId: openCodeInstanceId,
          cwd: process.cwd(),
          runtimeMode: "approval-required",
          memoryAccess: access,
        });
        const reserve = vi.spyOn(botMemoryStore, "reserveReviewCadence");
        const readSnapshot = vi.spyOn(botMemoryStore, "readPromptSnapshot");

        yield* controller.sendTurn({ threadId: claudeThreadId, input: "First legacy turn." });
        expect(bridge.sendTurn).toHaveBeenCalledTimes(1);
        expect(bridge.sendTurn.mock.calls[0]?.[0].persistentMemoryContext).toContain(
          "<user-memory>",
        );

        yield* settings.updateSettings({ memory: { enabled: false } });
        yield* controller.sendTurn({ threadId: claudeThreadId, input: "Memory off turn." });
        expect(bridge.sendTurn).toHaveBeenCalledTimes(2);
        expect(bridge.sendTurn.mock.calls[1]?.[0].persistentMemoryContext ?? "").not.toContain(
          "<user-memory>",
        );
        expect(reserve).toHaveBeenCalledTimes(1);
        expect(readSnapshot).toHaveBeenCalledTimes(1);

        yield* settings.updateSettings({ memory: { enabled: true } });
        yield* controller.sendTurn({ threadId: claudeThreadId, input: "Memory back on." });
        expect(bridge.sendTurn).toHaveBeenCalledTimes(3);
        expect(bridge.sendTurn.mock.calls[2]?.[0].persistentMemoryContext).toContain(
          "<user-memory>",
        );
        expect(reserve).toHaveBeenCalledTimes(2);
        expect(readSnapshot).toHaveBeenCalledTimes(2);
      }),
      bridge.service,
      mastra.factory,
      undefined,
      undefined,
      undefined,
      { botMemoryStore, ...credentials },
    ).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          McpMemoryToolSession.clearMcpMemoryToolSession(claudeThreadId);
          NodeFS.rmSync(memoryDir, { recursive: true, force: true });
        }),
      ),
    );
  });
});

describe("AgentControllerLive", () => {
  it.effect("feeds completed legacy-provider turns into observational memory", () => {
    const bridge = makeBridge();
    const mastra = makeMastraHarness();

    const events: ProviderRuntimeEvent[] = [
      {
        provider: ProviderDriverKind.make("opencode"),
        providerInstanceId: openCodeInstanceId,
        threadId: claudeThreadId,
        turnId: TurnId.make("legacy-turn"),
        type: "content.delta",
        eventId: EventId.make("legacy-memory-delta"),
        createdAt: "2026-09-13T20:00:00.000Z",
        payload: {
          delta: "The completed legacy answer.",
          streamKind: "assistant_text",
        },
      },
      {
        provider: ProviderDriverKind.make("opencode"),
        providerInstanceId: openCodeInstanceId,
        threadId: claudeThreadId,
        turnId: TurnId.make("legacy-turn"),
        type: "turn.completed",
        eventId: EventId.make("legacy-memory-complete"),
        createdAt: "2026-09-13T20:00:01.000Z",
        payload: { state: "completed", stopReason: null },
      },
    ];

    const service = { ...bridge.service, streamEvents: Stream.fromIterable(events) };

    return provideController(
      Effect.gen(function* () {
        const controller = yield* AgentController;
        yield* controller.resolveEngine({
          threadId: claudeThreadId,
          engine: { provider: "opencode", model: "gpt-5.6" },
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
        });
        yield* controller.sendTurn({ threadId: claudeThreadId, input: "Remember this turn." });
        yield* controller.streamEvents.pipe(Stream.take(2), Stream.runDrain);
        yield* Effect.promise(() => new Promise<void>((resolve) => queueMicrotask(resolve)));

        expect(mastra.observeExternalTurn).toHaveBeenCalledWith({
          threadId: String(claudeThreadId),
          turnId: "legacy-turn",
          modelId: "opencode/gpt-5.6",
          userMessages: [
            {
              id: expect.any(String),
              text: "Remember this turn.",
            },
          ],
          assistant: "The completed legacy answer.",
          createdAt: "2026-09-13T20:00:01.000Z",
        });
      }),
      service,
      mastra.factory,
    );
  });
});
