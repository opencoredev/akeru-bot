// @effect-diagnostics nodeBuiltinImport:off - The route/store integration guard reads source.
import * as NodeFS from "node:fs";

import { AVAILABLE_CONNECTION_STATE } from "@t3tools/client-runtime/connection";
import { describe, expect, it } from "vite-plus/test";

import {
  isRosterReady,
  resolveRosterListState,
  resolveRosterLoadState,
  resolveRoutedBot,
} from "./rosterRouteSelection";
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

  it("shows the load status, never a blank pane, before the roster arrives", () => {
    const sidebar = NodeFS.readFileSync(new URL("./BotRosterSidebar.tsx", import.meta.url), "utf8");
    const index = NodeFS.readFileSync(
      new URL("../../routes/_chat.index.tsx", import.meta.url),
      "utf8",
    );

    expect(sidebar).toContain('<RosterLoadStatus state={rosterLoadState} variant="sidebar" />');
    expect(index).toContain('<RosterLoadStatus state={loadState} variant="page" />');
    expect(index).not.toContain("if (!rosterReady || botId !== null) return null;");
  });
});

describe("resolveRosterLoadState", () => {
  const connection = (
    phase: "connecting" | "connected" | "backoff" | "blocked" | "offline",
    attempt = 1,
    lastFailure: { message: string } | null = null,
  ) =>
    ({ phase, attempt, lastFailure }) as Parameters<typeof resolveRosterLoadState>[0]["connection"];

  it("loads while the connection comes up or retries its first attempts", () => {
    expect(resolveRosterLoadState({ shellError: null, connection: null })).toEqual({
      kind: "loading",
    });
    expect(
      resolveRosterLoadState({ shellError: null, connection: connection("connecting") }),
    ).toEqual({ kind: "loading" });
    expect(
      resolveRosterLoadState({ shellError: null, connection: connection("backoff", 2) }),
    ).toEqual({ kind: "loading" });
  });

  it("fails with the reason when the first snapshot fails on a live connection", () => {
    expect(
      resolveRosterLoadState({
        shellError: "Could not synchronize environment data.",
        connection: connection("connected"),
      }),
    ).toEqual({ kind: "failed", message: "Could not synchronize environment data." });
  });

  it("fails when the connection is blocked, offline, or keeps failing", () => {
    expect(
      resolveRosterLoadState({
        shellError: null,
        connection: connection("blocked", 1, { message: "Pairing expired." }),
      }),
    ).toEqual({ kind: "failed", message: "Pairing expired." });
    expect(
      resolveRosterLoadState({ shellError: null, connection: connection("offline", 0) }),
    ).toEqual({ kind: "failed", message: "The environment is not reachable." });
    expect(
      resolveRosterLoadState({
        shellError: null,
        connection: connection("backoff", 3, { message: "Server unreachable." }),
      }),
    ).toEqual({ kind: "failed", message: "Server unreachable." });
  });

  it("offers a retry when the environment is not trying to connect", () => {
    expect(
      resolveRosterLoadState({ shellError: null, connection: { ...AVAILABLE_CONNECTION_STATE } }),
    ).toEqual({ kind: "failed", message: "The environment is not connected." });
    expect(
      resolveRosterLoadState({ shellError: null, connection: AVAILABLE_CONNECTION_STATE }),
    ).toEqual({ kind: "loading" });
  });
});
