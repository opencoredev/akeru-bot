import {
  ProviderDriverKind,
  THREAD_SILENT_RUN_ACTIVITY_KIND,
  THREAD_SILENT_RUN_CLEARED_ACTIVITY_KIND,
  ThreadSilentRunActivityPayload,
} from "@akeru/contracts";
import * as Schema from "effect/Schema";
import { afterEach, describe, expect, it } from "vite-plus/test";
import {
  asTurnId,
  SILENT_MS,
  asEventId,
  asThreadId,
  makeSilenceWatchdogHarness,
} from "./test-support/SilenceWatchdogHarness.ts";

describe("ProviderRuntimeIngestion silence watchdog", () => {
  const testScope = makeSilenceWatchdogHarness();
  const { createHarness, silentKinds, silenceIncidents } = testScope;
  afterEach(testScope.dispose);
  // Codex and Kimi run through the Mastra AgentController; Claude, Grok, and OpenCode
  // through the legacy adapter bridge. All reach ingestion as normalized runtime events.
  it.each(["codex", "kimi", "claude", "grok", "opencode"])(
    "records a silent run and one inbox item for a quiet %s turn without interrupting it",
    async (driver) => {
      const harness = await createHarness({
        provider: ProviderDriverKind.make(driver),
        botOwned: true,
      });

      const turnId = asTurnId(`turn-silent-${driver}`);
      harness.emitTurnStarted(turnId);
      await harness.drain();

      await harness.adjustClock(SILENT_MS - 1);
      await harness.drain();
      expect(await harness.watchdogActivities()).toHaveLength(0);

      await harness.adjustClock(1);
      await harness.drain();
      const watchdog = await harness.watchdogActivities();
      expect(silentKinds(watchdog)).toEqual([THREAD_SILENT_RUN_ACTIVITY_KIND]);
      expect(watchdog[0]?.turnId).toBe(turnId);
      expect(
        Schema.decodeUnknownSync(ThreadSilentRunActivityPayload)(watchdog[0]?.payload),
      ).toEqual({
        provider: driver,
        lastActivityAt: "1970-01-01T00:00:00.000Z",
      });
      expect(harness.interruptCalls).toEqual([]);

      const incidents = silenceIncidents(harness);
      expect(incidents).toHaveLength(1);
      expect(incidents[0]).toMatchObject({
        status: "open",
        incidentKey: `silence:thread-1:${turnId}`,
        botName: "Akeru",
        taskOrRoutine: "Watchdog thread",
      });
    },
  );

  it("clears the silent run and resolves the inbox item when output resumes", async () => {
    const harness = await createHarness({ botOwned: true });
    const turnId = "turn-resume";
    harness.emitTurnStarted(turnId);
    await harness.drain();
    await harness.adjustClock(SILENT_MS);
    await harness.drain();
    expect(silenceIncidents(harness)[0]?.status).toBe("open");

    await harness.adjustClock(1_000);
    harness.emitReasoning(turnId, "resume");
    await harness.drain();
    await harness.adjustClock(1);
    await harness.drain();

    expect(silentKinds(await harness.watchdogActivities())).toEqual([
      THREAD_SILENT_RUN_ACTIVITY_KIND,
      THREAD_SILENT_RUN_CLEARED_ACTIVITY_KIND,
    ]);
    expect(silenceIncidents(harness)).toMatchObject([{ status: "resolved" }]);
  });

  it("keeps one inbox item across repeated silent windows in the same turn", async () => {
    const harness = await createHarness({ botOwned: true });
    const turnId = "turn-repeated";
    harness.emitTurnStarted(turnId);
    await harness.drain();

    for (const window of [1, 2, 3]) {
      await harness.adjustClock(SILENT_MS);
      await harness.drain();
      await harness.adjustClock(1_000);
      harness.emitReasoning(turnId, `window-${window}`);
      await harness.drain();
    }

    await harness.adjustClock(SILENT_MS);
    await harness.drain();

    const incidents = silenceIncidents(harness);
    expect(incidents).toHaveLength(1);
    expect(incidents[0]).toMatchObject({ status: "open", occurrenceCount: 4 });
    const kinds = silentKinds(await harness.watchdogActivities());
    expect(kinds.filter((kind) => kind === THREAD_SILENT_RUN_ACTIVITY_KIND)).toHaveLength(4);
    expect(kinds.filter((kind) => kind === THREAD_SILENT_RUN_CLEARED_ACTIVITY_KIND)).toHaveLength(
      3,
    );
  });

  it("keeps the turn alive on reasoning and tool content deltas", async () => {
    const harness = await createHarness({ botOwned: true });
    const turnId = asTurnId("turn-delta-alive");
    harness.emitTurnStarted(turnId);
    await harness.drain();

    await harness.adjustClock(SILENT_MS - 10_000);
    harness.emitReasoning(turnId, "reasoning");
    await harness.drain();
    await harness.adjustClock(SILENT_MS - 5_000);
    await harness.drain();

    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-delta-tool"),
      provider: harness.provider,
      threadId: asThreadId("thread-1"),
      turnId,
      createdAt: "2026-01-01T00:00:00.000Z",
      payload: { streamKind: "command_output", delta: "tool output" },
    });
    await harness.drain();
    await harness.adjustClock(SILENT_MS - 5_000);
    await harness.drain();
    expect(await harness.watchdogActivities()).toHaveLength(0);
  });

  it("records the silent state without an inbox item for a chat with no bot", async () => {
    const harness = await createHarness();
    harness.emitTurnStarted("turn-no-bot");
    await harness.drain();
    await harness.adjustClock(SILENT_MS);
    await harness.drain();
    expect(silentKinds(await harness.watchdogActivities())).toEqual([
      THREAD_SILENT_RUN_ACTIVITY_KIND,
    ]);
    expect(silenceIncidents(harness)).toHaveLength(0);
  });
});
