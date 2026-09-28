// @effect-diagnostics nodeBuiltinImport:off - The route/store integration guard reads source.
import * as NodeFS from "node:fs";

import { describe, expect, it } from "vite-plus/test";

import { isRosterReady, resolveRosterListState, resolveRoutedBot } from "./rosterRouteSelection";
import type { Bot } from "./types";

function bot(id: string, archivedAt: string | null = null): Bot {
  return {
    id,
    name: id,
    title: "Assistant",
    label: null,
    description: null,
    disabledMcpServerIds: [],
    avatar: { kind: "blob", shape: "circle", color: "#5B7FD4" },
    engine: null,
    sandbox: null,
    runtimeMode: "full-access",
    usageCap: null,
    voiceEnabled: false,
    groupId: null,
    pinned: false,
    archivedAt,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
  };
}

describe("roster route selection", () => {
  it("waits for the active environment roster before judging a deep link", () => {
    expect(resolveRoutedBot(null, "env-old", [bot("akeru")], "akeru")).toEqual({
      status: "loading",
    });
    expect(resolveRoutedBot("env-new", null, [], "akeru")).toEqual({ status: "loading" });
    expect(resolveRoutedBot("env-new", "env-old", [bot("other")], "akeru")).toEqual({
      status: "loading",
    });
  });

  it("accepts the route bot after hydration even when another bot was selected", () => {
    const akeru = bot("akeru");

    expect(resolveRoutedBot("env-one", "env-one", [bot("previous"), akeru], "akeru")).toEqual({
      status: "available",
      bot: akeru,
    });
  });

  it("only reports a missing or archived bot after hydration", () => {
    expect(resolveRoutedBot("env-one", "env-one", [bot("other")], "akeru")).toEqual({
      status: "missing",
    });
    expect(
      resolveRoutedBot("env-one", "env-one", [bot("akeru", "2026-08-20T00:00:00.000Z")], "akeru"),
    ).toEqual({ status: "missing" });
  });

  it("does not route without a primary environment, including from a retained roster", () => {
    expect(isRosterReady(null, null)).toBe(false);
    expect(isRosterReady(null, "env-old")).toBe(false);
    expect(isRosterReady("env-one", null)).toBe(false);
    expect(isRosterReady("env-one", "env-one")).toBe(true);
  });

  it("feeds an available route bot back into the selection store", () => {
    const source = NodeFS.readFileSync(new URL("./BotThreadLanding.tsx", import.meta.url), "utf8");

    expect(source).toContain('if (routedBot.status === "loading") return;');
    expect(source).toContain("useRosterStore.getState().selectBot(botId)");
    expect(source).toContain("[botId, navigate, routedBot.status]");
  });
});

describe("resolveRosterListState", () => {
  it("stays blank until the first roster snapshot for this environment arrives", () => {
    expect(resolveRosterListState("env-1", null, [])).toBe("loading");
    expect(resolveRosterListState(null, null, [])).toBe("loading");
    expect(resolveRosterListState("env-2", "env-1", [bot("ada")])).toBe("loading");
  });

  it("says the roster is empty only once it has loaded without an active bot", () => {
    expect(resolveRosterListState("env-1", "env-1", [])).toBe("empty");
    expect(resolveRosterListState("env-1", "env-1", [bot("ada", "2026-08-02T00:00:00.000Z")])).toBe(
      "empty",
    );
    expect(resolveRosterListState("env-1", "env-1", [bot("ada")])).toBe("bots");
  });
});
