import { BotId, type AkeruBotUsageSnapshot } from "@akeru/contracts";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("react-native", () => ({ Text: "span", View: "div" }));

import { BotUsageDetails } from "./BotUsageDetails";
import { botUsageView } from "./botUsagePresentation";

const snapshot: AkeruBotUsageSnapshot = {
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
};

function render(query: {
  readonly data: AkeruBotUsageSnapshot | null;
  readonly error: string | null;
  readonly isPending: boolean;
}) {
  return renderToStaticMarkup(
    createElement(BotUsageDetails, { botName: "Scout", view: botUsageView(query) }),
  );
}

describe("mobile bot usage screen", () => {
  it("renders the loading state with no values", () => {
    const tree = render({ data: null, error: null, isPending: true });
    expect(tree).toContain("Loading…");
    expect(tree).not.toContain("Input");
  });

  it("renders the failed state without showing stale numbers", () => {
    const tree = render({ data: snapshot, error: "socket closed", isPending: false });
    expect(tree).toContain("Usage unavailable");
    expect(tree).toContain("Pull down to try again.");
    expect(tree).not.toContain("1,250");
    expect(tree).not.toContain("socket closed");
  });

  it("renders the empty state when nothing has been recorded", () => {
    const tree = render({ data: null, error: null, isPending: false });
    expect(tree).toContain("No usage");
    expect(tree).toContain("has not recorded any usage yet");
  });

  it("renders every measurement, the cap and its edit path, cost, pool, and reservations", () => {
    const tree = render({ data: snapshot, error: null, isPending: false });
    for (const value of [
      "Scout",
      "Input",
      "1,250",
      "Output",
      "2,500",
      "Observer",
      "300",
      "Reflector",
      "100",
      "Cap",
      "12,345 / 20,000 tokens",
      "chat settings",
      "Estimated cost",
      "$1.25",
      "Not subscription spend",
      "Subscription pool",
      "4,000 / 10,000 tokens",
      "Reserved",
      "750",
    ]) {
      expect(tree).toContain(value);
    }
    expect(tree).not.toContain("Some provider usage is unavailable.");
  });

  it("labels unavailable measurements instead of rendering them as zero", () => {
    const tree = render({
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
    });

    expect(tree).toContain("Unavailable");
    expect(tree).toContain("1,250+");
    expect(tree).toContain("No cap");
    expect(tree).toContain("Some provider usage is unavailable.");
    // Nothing reserved gets no row, matching web.
    expect(tree).not.toContain("Reserved");
    // The unavailable input measurement is labelled, never rendered as a count.
    expect(tree).toContain(
      '>Input</span><span class="font-sans text-lg text-foreground-muted">Unavailable</span>',
    );
    // A counted measurement keeps the plain foreground treatment.
    expect(tree).toContain(
      '>Observer</span><span class="font-sans text-lg tabular-nums text-foreground">300</span>',
    );
  });

  it("matches the unavailable labelling snapshot", () => {
    expect(
      render({
        data: {
          ...snapshot,
          measurements: {
            input: { tokens: 0, unavailableEntries: 1 },
            output: { tokens: 1_250, unavailableEntries: 2 },
            observer: { tokens: 0, unavailableEntries: 0 },
            reflector: { tokens: 0, unavailableEntries: 3 },
          },
          estimatedCost: { status: "unavailable", usd: null },
          subscriptionPool: { status: "unavailable", used: null, limit: null, unit: null },
        },
        error: null,
        isPending: false,
      }),
    ).toMatchSnapshot();
  });
});
