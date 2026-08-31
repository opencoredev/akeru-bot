import { EventId, TurnId, type OrchestrationThreadActivity } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { buildBotStepMeters, formatBotStepEngine } from "./botStepMeter.logic";

function activity(
  id: string,
  kind: string,
  payload: OrchestrationThreadActivity["payload"],
): OrchestrationThreadActivity {
  return {
    id: EventId.make(id),
    tone: "info",
    kind,
    summary: "Usage",
    payload,
    turnId: TurnId.make("turn-1"),
    createdAt: "2026-08-31T00:00:00.000Z",
  };
}

describe("bot step meter", () => {
  it("formats settled step usage and a hard stop", () => {
    const meters = buildBotStepMeters([
      activity("usage", "bot.step-usage.updated", {
        botId: "bot-1",
        engine: { provider: "codex", model: "gpt-5.6-sol" },
        tokens: 1_200,
        estimatedCost: { status: "available", usd: 0.42 },
      }),
      activity("cap", "bot.usage-cap.hit", { limit: 1_000 }),
    ]);

    expect(meters.get("turn-1")).toEqual({
      engine: { provider: "codex", model: "gpt-5.6-sol" },
      tokens: 1_200,
      costUsd: 0.42,
      hardStopReached: true,
    });
  });

  it("keeps unavailable usage explicit", () => {
    const meters = buildBotStepMeters([
      activity("usage", "bot.step-usage.updated", {
        botId: "bot-1",
        engine: { provider: "anthropic", model: "anthropic/claude-opus-5" },
        tokens: null,
        estimatedCost: { status: "unavailable", usd: null },
      }),
    ]);

    expect(meters.get("turn-1")).toMatchObject({ tokens: null, costUsd: null });
    expect(formatBotStepEngine(meters.get("turn-1")!.engine)).toBe("anthropic/claude-opus-5");
  });
});
