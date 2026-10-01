import { ProviderDriverKind } from "@akeru/contracts";
import { CommandId, DEFAULT_PROVIDER_INTERACTION_MODE } from "@akeru/contracts";
import { afterEach, describe, expect, it } from "vite-plus/test";
import {
  asTurnId,
  asEventId,
  asThreadId,
  asMessageId,
  createRuntimeIngestionHarness,
} from "./test-support/RuntimeIngestionHarness.ts";

describe("ProviderRuntimeIngestion", () => {
  const testScope = createRuntimeIngestionHarness();
  const { createHarness } = testScope;
  afterEach(testScope.dispose);
  it("records provider token usage and releases the remaining turn reservation", async () => {
    const harness = await createHarness({ botOwned: true });
    const turnId = asTurnId("turn-metered");
    await harness.reserveBotUsage(turnId);

    harness.emit({
      type: "thread.token-usage.updated",
      eventId: asEventId("evt-turn-usage"),
      provider: ProviderDriverKind.make("codex"),
      threadId: asThreadId("thread-1"),
      turnId,
      createdAt: "2026-01-01T00:00:01.000Z",
      payload: {
        usage: {
          usedTokens: 150,
          inputTokens: 100,
          outputTokens: 50,
          reasoningOutputTokens: 20,
        },
      },
    });
    harness.emit({
      type: "turn.completed",
      eventId: asEventId("evt-turn-usage-completed"),
      provider: ProviderDriverKind.make("codex"),
      threadId: asThreadId("thread-1"),
      turnId,
      createdAt: "2026-01-01T00:00:02.000Z",
      payload: { state: "completed" },
    });
    await harness.drain();

    const usage = await harness.summarizeBotUsage();
    expect(usage.consumedTokens).toBe(150);
    expect(usage.reservedTokens).toBe(0);
    expect(usage.entries[0]).toMatchObject({
      state: "reported",
      inputTokens: 100,
      outputTokens: 50,
      reasoningTokens: 20,
      settledAt: "2026-01-01T00:00:02.000Z",
    });
  });

  it("charges the reservation when a provider completes without token usage", async () => {
    const harness = await createHarness({ botOwned: true });
    const turnId = asTurnId("turn-unavailable-usage");
    await harness.reserveBotUsage(turnId);

    harness.emit({
      type: "turn.completed",
      eventId: asEventId("evt-turn-unavailable-usage-completed"),
      provider: ProviderDriverKind.make("codex"),
      threadId: asThreadId("thread-1"),
      turnId,
      createdAt: "2026-01-01T00:00:01.000Z",
      payload: { state: "completed" },
    });
    await harness.drain();

    const usage = await harness.summarizeBotUsage();
    expect(usage.consumedTokens).toBe(1_000);
    expect(usage.reservedTokens).toBe(0);
    expect(usage.entries[0]).toMatchObject({
      state: "unavailable",
      unavailableReason: "Provider completed without token usage.",
    });
  });

  it("keeps reported usage from a cancelled turn", async () => {
    const harness = await createHarness({ botOwned: true });
    const turnId = asTurnId("turn-cancelled-completed");
    await harness.reserveBotUsage(turnId);

    harness.emit({
      type: "thread.token-usage.updated",
      eventId: asEventId("evt-cancelled-completed-usage"),
      provider: ProviderDriverKind.make("codex"),
      threadId: asThreadId("thread-1"),
      turnId,
      createdAt: "2026-01-01T00:00:01.000Z",
      payload: { usage: { usedTokens: 150, inputTokens: 100, outputTokens: 50 } },
    });
    harness.emit({
      type: "turn.completed",
      eventId: asEventId("evt-cancelled-completed"),
      provider: ProviderDriverKind.make("codex"),
      threadId: asThreadId("thread-1"),
      turnId,
      createdAt: "2026-01-01T00:00:02.000Z",
      payload: { state: "cancelled", stopReason: "cancelled" },
    });
    await harness.drain();

    const usage = await harness.summarizeBotUsage();
    expect(usage.consumedTokens).toBe(150);
    expect(usage.reservedTokens).toBe(0);
    expect(usage.entries[0]).toMatchObject({
      state: "reported",
      inputTokens: 100,
      outputTokens: 50,
    });
  });

  it("does not charge a replacement reservation from stale turn events", async () => {
    const harness = await createHarness({ botOwned: true });
    const replacementTurnId = asTurnId("turn-replacement");
    const staleTurnId = asTurnId("turn-stale");
    await harness.dispatch({
      type: "thread.turn.start",
      commandId: CommandId.make("cmd-turn-start-replacement"),
      threadId: asThreadId("thread-1"),
      message: {
        messageId: asMessageId("message-replacement"),
        role: "user",
        text: "replace the old turn",
        attachments: [],
      },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "approval-required",
      createdAt: "2026-01-01T00:00:01.000Z",
    });
    await harness.dispatch({
      type: "thread.session.set",
      commandId: CommandId.make("cmd-session-replacement-active"),
      threadId: asThreadId("thread-1"),
      session: {
        threadId: asThreadId("thread-1"),
        status: "starting",
        providerName: "codex",
        runtimeMode: "approval-required",
        activeTurnId: staleTurnId,
        updatedAt: "2026-01-01T00:00:01.000Z",
        lastError: null,
      },
      createdAt: "2026-01-01T00:00:01.000Z",
    });
    harness.setProviderSession({
      provider: ProviderDriverKind.make("codex"),
      status: "running",
      runtimeMode: "approval-required",
      threadId: asThreadId("thread-1"),
      activeTurnId: replacementTurnId,
      createdAt: "2026-01-01T00:00:01.000Z",
      updatedAt: "2026-01-01T00:00:01.000Z",
    });
    await harness.reserveBotUsage(null);

    harness.emit({
      type: "thread.token-usage.updated",
      eventId: asEventId("evt-stale-turn-usage"),
      provider: ProviderDriverKind.make("codex"),
      threadId: asThreadId("thread-1"),
      turnId: staleTurnId,
      createdAt: "2026-01-01T00:00:02.000Z",
      payload: {
        usage: { usedTokens: 150, inputTokens: 100, outputTokens: 50 },
      },
    });
    harness.emit({
      type: "turn.completed",
      eventId: asEventId("evt-stale-turn-completed"),
      provider: ProviderDriverKind.make("codex"),
      threadId: asThreadId("thread-1"),
      turnId: staleTurnId,
      createdAt: "2026-01-01T00:00:03.000Z",
      payload: { state: "completed" },
    });
    await harness.drain();

    const usage = await harness.summarizeBotUsage();
    expect(usage.consumedTokens).toBe(0);
    expect(usage.reservedTokens).toBe(1_000);
    expect(usage.entries[0]).toMatchObject({ state: "reserved", turnId: null });

    harness.emit({
      type: "thread.token-usage.updated",
      eventId: asEventId("evt-replacement-turn-usage"),
      provider: ProviderDriverKind.make("codex"),
      threadId: asThreadId("thread-1"),
      turnId: replacementTurnId,
      createdAt: "2026-01-01T00:00:04.000Z",
      payload: {
        usage: { usedTokens: 150, inputTokens: 100, outputTokens: 50 },
      },
    });
    harness.emit({
      type: "turn.completed",
      eventId: asEventId("evt-replacement-turn-completed"),
      provider: ProviderDriverKind.make("codex"),
      threadId: asThreadId("thread-1"),
      turnId: replacementTurnId,
      createdAt: "2026-01-01T00:00:05.000Z",
      payload: { state: "completed" },
    });
    await harness.drain();

    const settledUsage = await harness.summarizeBotUsage();
    expect(settledUsage.consumedTokens).toBe(150);
    expect(settledUsage.reservedTokens).toBe(0);
    expect(settledUsage.entries[0]).toMatchObject({
      state: "reported",
      turnId: replacementTurnId,
    });
  });

  it("does not claim a replacement reservation without a provider turn identity", async () => {
    const harness = await createHarness({ botOwned: true });
    const untrackedTurnId = asTurnId("turn-untracked");
    await harness.dispatch({
      type: "thread.turn.start",
      commandId: CommandId.make("cmd-turn-start-replacement"),
      threadId: asThreadId("thread-1"),
      message: {
        messageId: asMessageId("message-replacement"),
        role: "user",
        text: "replace the old turn",
        attachments: [],
      },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "approval-required",
      createdAt: "2026-01-01T00:00:01.000Z",
    });
    await harness.reserveBotUsage(null);

    harness.emit({
      type: "thread.token-usage.updated",
      eventId: asEventId("evt-replacement-turn-usage"),
      provider: ProviderDriverKind.make("codex"),
      threadId: asThreadId("thread-1"),
      turnId: untrackedTurnId,
      createdAt: "2026-01-01T00:00:02.000Z",
      payload: {
        usage: { usedTokens: 150, inputTokens: 100, outputTokens: 50 },
      },
    });
    harness.emit({
      type: "turn.completed",
      eventId: asEventId("evt-replacement-turn-completed"),
      provider: ProviderDriverKind.make("codex"),
      threadId: asThreadId("thread-1"),
      turnId: untrackedTurnId,
      createdAt: "2026-01-01T00:00:03.000Z",
      payload: { state: "completed" },
    });
    await harness.drain();

    const usage = await harness.summarizeBotUsage();
    expect(usage.consumedTokens).toBe(0);
    expect(usage.reservedTokens).toBe(1_000);
    expect(usage.entries[0]).toMatchObject({
      state: "reserved",
      turnId: null,
    });
  });
});
