import { BotId, EventId, TurnId, type OrchestrationThreadActivity } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { buildBotStepMeters, buildBotUsageCapPatch, formatBotStepEngine } from "./botStepUsage";

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

describe("mobile bot step usage", () => {
  it("derives settled usage and a hard stop", () => {
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
    expect(formatBotStepEngine(meters.get("turn-1")!.engine)).toBe("codex/gpt-5.6-sol");
  });

  it("builds set and clear patches without changing other bot fields", () => {
    const botId = BotId.make("bot-1");

    expect(buildBotUsageCapPatch(botId, "50000")).toEqual({
      botId,
      usageCap: { unit: "tokens", limit: 50_000 },
    });
    expect(buildBotUsageCapPatch(botId, " ")).toEqual({ botId, usageCap: null });
    expect(buildBotUsageCapPatch(botId, "1.5")).toBeNull();
    expect(buildBotUsageCapPatch(botId, "0")).toBeNull();
  });
});
