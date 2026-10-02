import { BotId } from "@akeru/contracts";
import { describe, expect, it } from "vite-plus/test";

import { buildBotUsageCapPatch, resolveBotUsageCapForProvider } from "./botStepUsage";

describe("mobile bot step usage", () => {
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

  it("clears hard stops for occupancy-only providers", () => {
    const botId = BotId.make("bot-1");

    expect(resolveBotUsageCapForProvider("50000", "grok")).toEqual({
      available: false,
      limit: null,
    });
    expect(buildBotUsageCapPatch(botId, "50000", "grok")).toEqual({
      botId,
      usageCap: null,
    });
    expect(buildBotUsageCapPatch(botId, "50000", "codex")).toEqual({
      botId,
      usageCap: { unit: "tokens", limit: 50_000 },
    });
  });
});
