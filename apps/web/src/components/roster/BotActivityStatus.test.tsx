import { ProviderDriverKind, TurnId, type OrchestrationThreadActivity } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { botActivityUpdate, BotActivityStatus } from "./BotActivityStatus";

const avatar = { kind: "blob", shape: "circle", color: "#5B7FD4" } as const;
const NOW = new Date("2026-09-15T18:00:00.000Z");

describe("bot activity status", () => {
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

  it("adds the elapsed timer only when the turn start is known", () => {
    const withStart = renderToStaticMarkup(
      <BotActivityStatus
        avatar={avatar}
        name="Akeru"
        startedAt={new Date(NOW.getTime() - 12_000).toISOString()}
      />,
    );
    const withoutStart = renderToStaticMarkup(<BotActivityStatus avatar={avatar} name="Akeru" />);

    expect(withStart).toContain('data-testid="response-loading-time">12s<');
    expect(withoutStart).not.toContain("response-loading-time");
  });

  it("replaces the working shimmer with a silent-run notice", () => {
    const markup = renderToStaticMarkup(
      <BotActivityStatus
        avatar={avatar}
        name="Akeru"
        startedAt={new Date(NOW.getTime() - 300_000).toISOString()}
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
    expect(markup).not.toContain("bot-status-shimmer");
    expect(markup).not.toContain("Akeru is working");
  });

  it("drops the avatar when compact, for rails that already name the bot", () => {
    const compact = renderToStaticMarkup(
      <BotActivityStatus avatar={avatar} compact name="Akeru" update="Searching the web" />,
    );

    expect(compact).toContain("Akeru · Searching the web");
    expect(compact).not.toContain("bot-avatar");
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
