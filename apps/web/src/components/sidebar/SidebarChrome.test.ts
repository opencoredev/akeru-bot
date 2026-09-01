// @effect-diagnostics nodeBuiltinImport:off - This integration guard reads related source files.
import * as NodeFS from "node:fs";
import { BotId, McpServerId, ThreadId, type McpServer } from "@t3tools/contracts";

import { describe, expect, it } from "vite-plus/test";

import { loadCatalog } from "../../../../../plugins";
import {
  findActiveComputerUseControl,
  formatEnabledPluginBadge,
  formatEnabledPluginStatus,
  summarizeEnabledPlugins,
} from "./SidebarChrome";

const catalogPlugin = loadCatalog().find((plugin) => plugin.id === "exa");
if (!catalogPlugin) throw new TypeError("Exa must remain in the plugin catalog.");

function server(id: string, enabled = true): McpServer {
  return {
    id: McpServerId.make(id),
    name: id,
    transport: "url",
    url: "https://mcp.example.com",
    enabled,
    createdAt: "2026-08-27T00:00:00.000Z",
    updatedAt: "2026-08-27T00:00:00.000Z",
  };
}

describe("sidebar footer", () => {
  it("describes real enabled state without claiming an account connection", () => {
    expect(formatEnabledPluginStatus(0)).toBe("No plugins enabled");
    expect(formatEnabledPluginStatus(1)).toBe("1 plugin enabled");
    expect(formatEnabledPluginStatus(3)).toBe("3 plugins enabled");
  });

  it("shows a compact plugin count without overflowing the icon", () => {
    expect(formatEnabledPluginBadge(0)).toBeNull();
    expect(formatEnabledPluginBadge(3)).toBe("3");
    expect(formatEnabledPluginBadge(100)).toBe("99+");
  });

  it("counts removed builtins and custom MCP servers without inventing catalog logos", () => {
    const summary = summarizeEnabledPlugins(
      [server("builtin-exa"), server("builtin-removed-vendor"), server("custom-mcp")],
      [catalogPlugin],
    );

    expect(summary.enabledCount).toBe(3);
    expect(summary.enabledPlugins).toEqual([catalogPlugin]);
  });

  it("shows only the bot that holds an enabled Computer Use session", () => {
    const botId = BotId.make("bot-1");
    const input: Parameters<typeof findActiveComputerUseControl>[0] = {
      mcpServers: [server("builtin-computer-use")],
      bots: [
        {
          id: botId,
          name: "Operator",
          title: "Operator",
          label: null,
          description: "",
          engine: null,
          sandbox: null,
          runtimeMode: "approval-required",
          usageCap: null,
          voiceEnabled: false,
          channelBindings: [],
          groupId: null,
          disabledMcpServerIds: [],
          avatar: { kind: "blob", shape: "circle", color: "#5B7FD4" },
          archivedAt: null,
          createdAt: "2026-08-27T00:00:00.000Z",
          updatedAt: "2026-08-27T00:00:00.000Z",
        },
      ],
      threads: [
        {
          id: ThreadId.make("thread-1"),
          botId,
          projectId: "project-1" as never,
          title: "Control",
          modelSelection: { instanceId: "codex" as never, model: "gpt-5.6-sol" },
          runtimeMode: "approval-required",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          latestTurn: null,
          createdAt: "2026-08-27T00:00:00.000Z",
          updatedAt: "2026-08-27T00:00:00.000Z",
          archivedAt: null,
          settledOverride: null,
          settledAt: null,
          session: {
            threadId: ThreadId.make("thread-1"),
            status: "ready",
            providerName: "codex",
            runtimeMode: "approval-required",
            mcpServerIds: [McpServerId.make("builtin-computer-use")],
            activeTurnId: null,
            lastError: null,
            updatedAt: "2026-08-27T00:00:00.000Z",
          },
          latestUserMessageAt: null,
          hasPendingApprovals: false,
          hasPendingUserInput: false,
          hasActionableProposedPlan: false,
        },
      ],
    };
    const control = findActiveComputerUseControl(input);

    expect(control).toEqual({ threadId: ThreadId.make("thread-1"), botName: "Operator" });
    for (const status of ["starting", "error", "stopped"] as const) {
      expect(
        findActiveComputerUseControl({
          ...input,
          threads: input.threads.map((thread) => ({
            ...thread,
            session: thread.session ? { ...thread.session, status } : null,
          })),
        }),
      ).toBeNull();
    }
    expect(
      findActiveComputerUseControl({
        ...input,
        mcpServers: [server("builtin-computer-use", false)],
      }),
    ).toBeNull();
    expect(
      findActiveComputerUseControl({
        ...input,
        threads: input.threads.map((thread) => ({
          ...thread,
          session: thread.session ? { ...thread.session, mcpServerIds: [] } : null,
        })),
      }),
    ).toBeNull();
  });

  it("keeps the error inbox in Settings instead of the sidebar", () => {
    const source = NodeFS.readFileSync(new URL("./SidebarChrome.tsx", import.meta.url), "utf8");

    expect(source).not.toContain("SidebarInboxSummary");
    expect(source).not.toContain('openSettings("inbox")');
  });

  it("creates manual bots with approval required without adding a first-run bot", () => {
    const rosterSource = NodeFS.readFileSync(
      new URL("../roster/BotRosterSidebar.tsx", import.meta.url),
      "utf8",
    );
    const syncSource = NodeFS.readFileSync(
      new URL("../roster/useServerRoster.ts", import.meta.url),
      "utf8",
    );

    expect(rosterSource).toContain("runtimeMode: DEFAULT_BOT_RUNTIME_MODE");
    expect(rosterSource).not.toContain('runtimeMode: "full-access"');
    expect(syncSource).not.toContain('BotId.make("bot-akeru")');
    expect(syncSource).not.toContain("botEnvironment.create");
  });

  it("updates existing bot and group threads before starting the next turn", () => {
    const botSource = NodeFS.readFileSync(
      new URL("../roster/useBotThreadRuntime.ts", import.meta.url),
      "utf8",
    );
    const groupSource = NodeFS.readFileSync(
      new URL("../roster/useGroupThreadRuntime.ts", import.meta.url),
      "utf8",
    );

    for (const source of [botSource, groupSource]) {
      const modeUpdate = source.indexOf("const modeResult = await setRuntimeMode");
      expect(modeUpdate).toBeGreaterThan(-1);
      expect(modeUpdate).toBeLessThan(source.indexOf("await startTurn", modeUpdate));
    }
  });

  it("mints fresh web and mobile threads from the local execution setting", () => {
    const webSource = NodeFS.readFileSync(
      new URL("../../hooks/useHandleNewThread.ts", import.meta.url),
      "utf8",
    );
    const mobileSource = NodeFS.readFileSync(
      new URL(
        "../../../../mobile/src/features/threads/new-task-flow-provider.tsx",
        import.meta.url,
      ),
      "utf8",
    );

    expect(webSource).toContain(
      "runtimeMode: carryRuntimeMode ?? primaryServerSettings.localExecutionMode",
    );
    expect(mobileSource).toContain("selectedEnvironmentServerConfig?.settings.localExecutionMode");
  });

  it("keeps the roster scrollable from touch gestures that start on a bot row", () => {
    const source = NodeFS.readFileSync(
      new URL("../roster/BotRosterSidebar.tsx", import.meta.url),
      "utf8",
    );

    expect(source).toContain("touch-pan-y");
    expect(source).not.toContain("touch-none");
  });

  it("keeps group membership out of roster drag and centers pinned items", () => {
    const source = NodeFS.readFileSync(
      new URL("../roster/BotRosterSidebar.tsx", import.meta.url),
      "utf8",
    );

    expect(source).not.toContain("botEnvironment.groups.assignMember");
    expect(source).toContain('className="flex justify-center gap-2 overflow-x-auto px-2 py-1"');
    expect(source).toContain("onContextMenu={(event) => {");
  });

  it("keeps short plugin dialogs and the footer independently scrollable", () => {
    const sidebarSource = NodeFS.readFileSync(
      new URL("./SidebarChrome.tsx", import.meta.url),
      "utf8",
    );
    const pluginsSource = NodeFS.readFileSync(
      new URL("../plugins/PluginsDialog.tsx", import.meta.url),
      "utf8",
    );

    expect(sidebarSource).toContain("overflow-y-auto overscroll-contain");
    expect(pluginsSource).toContain("PLUGIN_DIRECTORY_HEADER_CLASS_NAME");
    expect(pluginsSource).toContain('<DialogPanel className="space-y-4 px-6 py-5">');
  });
});
