// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import { describe, expect, it, vi } from "vite-plus/test";

import { buildThreadWorkspaceActions, runThreadWorkspaceAction } from "./threadWorkspaceActions";

/** Mirrors how ThreadRouteScreen gates each entry for one chat. */
function actionsFor(input: {
  readonly usesSplitView: boolean;
  readonly inspectorSupported: boolean;
  readonly threadCwd: string | null;
  readonly workspaceRoot: string | null;
}) {
  return buildThreadWorkspaceActions({
    canOpenFiles: input.inspectorSupported && input.threadCwd !== null,
    canOpenTerminal: Boolean(input.workspaceRoot),
    canOpenGit: true,
    canToggleInspector:
      !input.usesSplitView && input.inspectorSupported && input.threadCwd !== null,
  }).map((action) => action.id);
}

const projectBacked = {
  inspectorSupported: true,
  threadCwd: "/work/akeru",
  workspaceRoot: "/work/akeru",
};

describe("thread workspace actions", () => {
  it("exposes files, terminal, git, and the inspector in compact layout", () => {
    expect(actionsFor({ ...projectBacked, usesSplitView: false })).toEqual([
      "files",
      "terminal",
      "git",
      "inspector",
    ]);
  });

  it("drops the inspector toggle in split view, where the pane is already on screen", () => {
    expect(actionsFor({ ...projectBacked, usesSplitView: true })).toEqual([
      "files",
      "terminal",
      "git",
    ]);
  });

  it("keeps git reachable for a chat with no working directory", () => {
    expect(
      actionsFor({
        usesSplitView: false,
        inspectorSupported: true,
        threadCwd: null,
        workspaceRoot: null,
      }),
    ).toEqual(["git"]);
  });

  it("offers the terminal for a project chat before its working directory resolves", () => {
    expect(
      actionsFor({
        usesSplitView: false,
        inspectorSupported: true,
        threadCwd: null,
        workspaceRoot: "/work/akeru",
      }),
    ).toEqual(["terminal", "git"]);
  });

  it("keeps Git reachable when the inspector is unsupported and there is no project", () => {
    expect(
      actionsFor({
        usesSplitView: false,
        inspectorSupported: false,
        threadCwd: null,
        workspaceRoot: null,
      }),
    ).toEqual(["git"]);
  });

  it("gives every action a title and an icon so the overflow menu is legible", () => {
    const actions = buildThreadWorkspaceActions({
      canOpenFiles: true,
      canOpenTerminal: true,
      canOpenGit: true,
      canToggleInspector: true,
    });

    expect(actions).toHaveLength(4);
    for (const action of actions) {
      expect(action.title.length).toBeGreaterThan(0);
      expect(action.image.length).toBeGreaterThan(0);
    }
  });
});

describe("thread workspace action dispatch", () => {
  function handlers() {
    return {
      openFiles: vi.fn(),
      openTerminal: vi.fn(),
      openGit: vi.fn(),
      toggleInspector: vi.fn(),
    };
  }

  it("opens files, terminal, git, and the inspector from their own entries", () => {
    for (const [id, called] of [
      ["files", "openFiles"],
      ["terminal", "openTerminal"],
      ["git", "openGit"],
      ["inspector", "toggleInspector"],
    ] as const) {
      const spies = handlers();
      runThreadWorkspaceAction(id, spies);

      expect(spies[called], id).toHaveBeenCalledTimes(1);
      for (const [name, spy] of Object.entries(spies)) {
        if (name !== called) expect(spy, `${id} -> ${name}`).not.toHaveBeenCalled();
      }
    }
  });

  it("dispatches every action the compact overflow offers", () => {
    const spies = handlers();
    const actions = buildThreadWorkspaceActions({
      canOpenFiles: true,
      canOpenTerminal: true,
      canOpenGit: true,
      canToggleInspector: true,
    });

    for (const action of actions) runThreadWorkspaceAction(action.id, spies);

    for (const spy of Object.values(spies)) expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe("thread route wiring", () => {
  // The route mounts a navigator and a live connection, so its wiring is
  // asserted against the source: these four lines are what made the tools
  // reachable, and each one regressed independently before.
  const source = NodeFS.readFileSync(new URL("./ThreadRouteScreen.tsx", import.meta.url), "utf8");

  it("keeps the workspace tools in the iOS header on both layouts", () => {
    expect(source).toContain(
      "layout.usesSplitView ? threadCenterHeaderItems : compactRightHeaderItems",
    );
  });

  it("gives Android the overflow control", () => {
    expect(source).toContain("workspaceActions={workspaceActions}");
    expect(source).toContain("onWorkspaceAction={handleWorkspaceAction}");
  });

  it("mounts the fallback toolbar only for compact iOS without the glass header", () => {
    expect(source).toContain(
      'Platform.OS !== "android" && !layout.usesSplitView && !usesNativeHeaderGlass',
    );
    expect(source).not.toContain("renderThreadRouteBody(false)");
  });
});
