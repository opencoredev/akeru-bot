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

import { BotUsageSection, formatUsageMeasurement } from "./BotUsageSection";

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
  estimatedCost: { status: "available", usd: 1.25 },
  subscriptionPool: { status: "available", used: 4_000, limit: 10_000, unit: "tokens" },
} as const;

describe("formatUsageMeasurement", () => {
  beforeEach(() => {
    state.query.mockReset();
    state.summary.mockClear();
  });

  it("distinguishes exact, partial, and unavailable provider usage", () => {
    expect(formatUsageMeasurement({ tokens: 1_250, unavailableEntries: 0 })).toBe("1,250");
    expect(formatUsageMeasurement({ tokens: 1_250, unavailableEntries: 1 })).toBe("1,250+");
    expect(formatUsageMeasurement({ tokens: 0, unavailableEntries: 1 })).toBe("Unavailable");
  });

  it("renders loading, empty, and failed usage states", () => {
    state.query.mockReturnValueOnce({ data: null, error: null, isPending: true, refresh: vi.fn() });
    expect(render()).toContain("Loading…");
    state.query.mockReturnValueOnce({
      data: null,
      error: null,
      isPending: false,
      refresh: vi.fn(),
    });
    expect(render()).toContain("No usage");
    state.query.mockReturnValueOnce({
      data: null,
      error: "Usage request failed.",
      isPending: false,
      refresh: vi.fn(),
    });
    expect(render()).toContain("Usage unavailable");
  });

  it("renders complete per-bot usage, cap, cost, pool, and reservations", () => {
    state.query.mockReturnValue({
      data: snapshot,
      error: null,
      isPending: false,
      refresh: vi.fn(),
    });
    const markup = render();

    expect(state.summary).toHaveBeenCalledWith({
      environmentId: EnvironmentId.make("environment-1"),
      input: { botId: BotId.make("bot-1") },
    });
    for (const value of [
      "Input",
      "1,250",
      "Output",
      "2,500",
      "Observer",
      "300",
      "Reflector",
      "100",
    ]) {
      expect(markup).toContain(value);
    }
    expect(markup).toContain("12,345 / 20,000");
    expect(markup).toContain("$1.25");
    expect(markup).toContain("4,000 / 10,000 tokens");
    expect(markup).toContain("Reserved");
    expect(markup).toContain("750");
    expect(markup).not.toContain("Some provider usage is unavailable.");
  });

  it("marks partial and unavailable provider measurements without inventing values", () => {
    state.query.mockReturnValue({
      data: {
        ...snapshot,
        reservedTokens: 0,
        usageCap: null,
        measurements: {
          ...snapshot.measurements,
          input: { tokens: 0, unavailableEntries: 1 },
          output: { tokens: 1_250, unavailableEntries: 2 },
        },
        estimatedCost: { status: "unavailable", usd: null },
        subscriptionPool: { status: "unavailable", used: null, limit: null, unit: null },
      },
      error: null,
      isPending: false,
      refresh: vi.fn(),
    });
    const markup = render();

    expect(markup).toContain("1,250+");
    expect(markup).toContain('>Estimated cost</span><span class="text-right">Unavailable</span>');
    expect(markup).toContain(
      '>Subscription pool</span><span class="text-right">Unavailable</span>',
    );
    expect(markup).toContain("Some provider usage is unavailable.");
    expect(markup).toContain("No cap");
    expect(markup).not.toContain("Reserved</span>");
  });
});
