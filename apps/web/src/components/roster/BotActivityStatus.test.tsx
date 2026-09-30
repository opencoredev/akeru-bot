import { ProviderDriverKind, TurnId, type OrchestrationThreadActivity } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { botActivityUpdate, BotActivityStatus } from "./BotActivityStatus";

const NOW = new Date("2026-09-15T18:00:00.000Z");

describe("bot activity status", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows only the pixel glyph and a shimmering short update", () => {
    const markup = renderToStaticMarkup(
      <BotActivityStatus name="Akeru" activity={{ label: "Running a command" }} />,
    );

    expect(markup).toContain("Running a command...");
    expect(markup).toContain("bot-thinking-glyph");
    expect(markup).toContain("bot-shimmer-text");
    expect(markup).not.toContain("<button");
    expect(markup).not.toContain("Step");
  });

  it("falls back to the summary update, then to plain working", () => {
    expect(
      renderToStaticMarkup(<BotActivityStatus name="Akeru" update="Searching the web" />),
    ).toContain("Searching the web...");
    expect(renderToStaticMarkup(<BotActivityStatus name="Akeru" />)).toContain(
      "Akeru is working...",
    );
  });

  it("replaces the working shimmer with a silent-run notice", () => {
    const markup = renderToStaticMarkup(
      <BotActivityStatus
        name="Akeru"
        activity={{ label: "Running a command" }}
        silentRun={{
          provider: ProviderDriverKind.make("kimi"),
          providerName: "Kimi For Coding",
          lastActivityAt: new Date(NOW.getTime() - 120_000).toISOString(),
        }}
      />,
    );

    expect(markup).toContain("data-silent-run");
    expect(markup).toContain("No response from Kimi For Coding");
    expect(markup).toContain('data-testid="response-loading-time">2m');
    expect(markup).not.toContain("bot-shimmer-text");
    expect(markup).not.toContain("Running a command");
  });

  it("turns the latest unfinished action into a short status update", () => {
    const turnId = TurnId.make("turn-1");
    const activities = [
      { turnId, kind: "tool.completed", tone: "tool", summary: "Browser navigate completed" },
      { turnId, kind: "tool.started", tone: "tool", summary: "Browser snapshot started" },
      { turnId, kind: "checkpoint.captured", tone: "system", summary: "Checkpoint captured" },
    ] as OrchestrationThreadActivity[];

    expect(botActivityUpdate(activities, turnId)).toBe("Reading the page");
    expect(botActivityUpdate(activities, TurnId.make("turn-2"))).toBeNull();
    expect(botActivityUpdate(activities, null)).toBeNull();
  });

  it("falls back to plain working between completed actions and after a question", () => {
    const turnId = TurnId.make("turn-1");
    const settled = [
      { turnId, kind: "tool.started", tone: "tool", summary: "Browser snapshot started" },
      { turnId, kind: "tool.completed", tone: "tool", summary: "Browser snapshot completed" },
    ] as OrchestrationThreadActivity[];
    const answered = [
      { turnId, kind: "item.completed", tone: "tool", summary: "Akeru ask user completed" },
    ] as OrchestrationThreadActivity[];

    expect(botActivityUpdate(settled, turnId)).toBeNull();
    expect(botActivityUpdate(answered, turnId)).toBeNull();
  });

  it("keeps an unrecognized tool honest instead of dropping it", () => {
    const turnId = TurnId.make("turn-1");
    const activities = [
      { turnId, kind: "tool.started", tone: "tool", summary: "render_invoice started" },
    ] as OrchestrationThreadActivity[];

    expect(botActivityUpdate(activities, turnId)).toBe("Render invoice");
  });
});
