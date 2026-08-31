import { BotId, EnvironmentId } from "@t3tools/contracts";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  query: vi.fn(),
  summary: vi.fn(() => ({})),
}));

vi.mock("../../state/query", () => ({ useEnvironmentQuery: state.query }));
vi.mock("../../state/botUsage", () => ({
  botUsageEnvironment: { summary: state.summary },
}));

import { BotUsageSection, formatBotUsage } from "./BotUsageSection";

const render = () =>
  renderToStaticMarkup(
    createElement(BotUsageSection, {
      environmentId: EnvironmentId.make("environment-1"),
      botId: "bot-1",
    }),
  );

const snapshot = {
  botId: BotId.make("bot-1"),
  consumedTokens: 12_345,
  reservedTokens: 750,
  measurements: {
    input: { tokens: 1_250, unavailableEntries: 0 },
    output: { tokens: 2_500, unavailableEntries: 0 },
    observer: { tokens: 300, unavailableEntries: 0 },
    reflector: { tokens: 100, unavailableEntries: 0 },
  },
  entries: [],
  usageCap: { unit: "tokens", limit: 20_000 },
  estimatedCost: { status: "unavailable", usd: null },
  subscriptionPool: { status: "unavailable", used: null, limit: null, unit: null },
} as const;

describe("BotUsageSection", () => {
  beforeEach(() => {
    state.query.mockReset();
    state.summary.mockClear();
  });

  it("distinguishes exact, partial, and unavailable usage", () => {
    expect(formatBotUsage({ tokens: 1_250, unavailableEntries: 0 })).toBe("1,250");
    expect(formatBotUsage({ tokens: 1_250, unavailableEntries: 1 })).toBe("1,250+");
    expect(formatBotUsage({ tokens: 0, unavailableEntries: 1 })).toBe("Unavailable");
  });

  it("shows usage, memory work, cap, and reservations", () => {
    state.query.mockReturnValue({
      data: snapshot,
      error: null,
      isPending: false,
      refresh: vi.fn(),
    });
    const markup = render();

    expect(markup).toContain("1,250");
    expect(markup).toContain("2,500");
    expect(markup).toContain("400");
    expect(markup).toContain("12,345 / 20,000");
    expect(markup).toContain("750 reserved");
  });

  it("shows reached and unavailable states without invented values", () => {
    state.query.mockReturnValue({
      data: {
        ...snapshot,
        consumedTokens: 20_000,
        reservedTokens: 0,
        measurements: {
          ...snapshot.measurements,
          observer: { tokens: 0, unavailableEntries: 1 },
        },
      },
      error: null,
      isPending: false,
      refresh: vi.fn(),
    });
    const markup = render();

    expect(markup).toContain("Cap reached");
    expect(markup).toContain("100+");
  });
});
