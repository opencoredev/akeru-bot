// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { LocalFilesystem, LocalSandbox, Workspace } from "@mastra/core/workspace";
import { BotId, McpServerId, ThreadId } from "@t3tools/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { AkeruSessionResources } from "./AkeruSessionResources.ts";
import { createBotBrowserTools } from "./botBrowser.ts";
import { computerRegistry } from "./computerRegistry.ts";
import { WorkspaceComputer } from "./workspaceComputer.ts";
import { CODEX_COMPUTER_USE_SERVER_ID } from "./CodexComputerUse.ts";
import { createBotBrowser } from "./botBrowser.ts";
import {
  type AkeruBotWorkspace,
  type AkeruRemoteSession,
  createRemoteBotWorkspace,
} from "./botWorkspace.ts";

const directories = new Set<string>();

function stateDir() {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "akeru-resources-"));
  directories.add(directory);
  return directory;
}

function workspace() {
  return new Workspace({
    filesystem: new LocalFilesystem({ basePath: process.cwd() }),
    sandbox: new LocalSandbox({ workingDirectory: process.cwd() }),
  });
}

function localBotWorkspace(value: Workspace): AkeruBotWorkspace {
  return {
    id: value.id,
    provider: "local",
    workspace: value,
    inspect: async () => "running",
    wake: () => value.init(),
    sleep: () => value.stop(),
    destroy: () => value.destroy(),
  };
}

function browser(overrides?: { reconnect?: () => Promise<void>; close?: () => Promise<void> }) {
  return {
    tools: {},
    attachment: vi.fn(async () => undefined),
    reconnect: vi.fn(overrides?.reconnect ?? (async () => undefined)),
    close: vi.fn(overrides?.close ?? (async () => undefined)),
  };
}

function computerServer() {
  return {
    id: CODEX_COMPUTER_USE_SERVER_ID as never,
    name: "Computer Use",
    transport: "stdio" as const,
    command: "akeru-codex-computer-use",
    enabled: true,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function mcpManager(
  status: { connected: boolean; toolCount: number; error?: string },
  tools: Record<string, unknown> = {},
) {
  return {
    init: vi.fn(async () => undefined),
    disconnect: vi.fn(async () => undefined),
    getTools: vi.fn(() => tools),
    getServerStatuses: vi.fn(() => [
      {
        name: CODEX_COMPUTER_USE_SERVER_ID,
        transport: "stdio" as const,
        toolNames: status.toolCount > 0 ? [`${CODEX_COMPUTER_USE_SERVER_ID}_control`] : [],
        ...status,
      },
    ]),
  };
}

const remoteInput = {
  resourceScope: "shared",
  workspaceResourceKey: "vercel:shared",
  workspaceId: "akeru-shared",
  botSandbox: "vercel" as const,
  mcpServers: [],
};

const exaServer = {
  id: McpServerId.make("builtin-exa"),
  name: "Exa",
  transport: "url" as const,
  url: "https://mcp.exa.ai/mcp",
  enabled: true,
  createdAt: "2026-08-31T00:00:00.000Z",
  updatedAt: "2026-08-31T00:00:00.000Z",
};

describe("AkeruSessionResources", () => {
  afterEach(() => {
    for (const directory of directories) {
      NodeFS.rmSync(directory, { recursive: true, force: true });
    }
    directories.clear();
  });

  it("shares one workspace and browser across thread sessions", async () => {
    const remote = workspace();
    const makeRemoteWorkspace = vi.fn(async () => localBotWorkspace(remote));
    const sharedBrowser = browser();
    const makeBotBrowser = vi.fn(() => sharedBrowser);
    const resources = new AkeruSessionResources({
      stateDir: stateDir(),
      makeRemoteWorkspace,
      makeBotBrowser,
      toMcpServerConfigs: () => ({}),
    });

    const first = await resources.acquire({ ...remoteInput, threadId: "first" });
    const second = await resources.acquire({ ...remoteInput, threadId: "second" });
    expect(first.workspace).toBe(second.workspace);
    expect(makeRemoteWorkspace).toHaveBeenCalledOnce();
    expect(makeBotBrowser).toHaveBeenCalledOnce();

    await resources.release("first");
    await resources.release("second");
    await resources.acquire({ ...remoteInput, threadId: "third" });
    expect(sharedBrowser.reconnect).toHaveBeenCalledOnce();
    await resources.shutdown();
    expect(sharedBrowser.close).toHaveBeenCalledOnce();
  });

  it("retries failed workspace sleeps after releasing sessions during shutdown", async () => {
    const remote = workspace();
    const botWorkspace = {
      ...localBotWorkspace(remote),
      provider: "vercel" as const,
      sleep: vi
        .fn()
        .mockRejectedValueOnce(new Error("pause unavailable"))
        .mockResolvedValue(undefined),
    };
    const resources = new AkeruSessionResources({
      stateDir: stateDir(),
      makeRemoteWorkspace: async () => botWorkspace,
      makeBotBrowser: () => browser(),
      toMcpServerConfigs: () => ({}),
    });

    await resources.acquire({ ...remoteInput, threadId: "shutdown-retry" });
    await expect(resources.shutdown()).rejects.toThrow("pause unavailable");
    expect(botWorkspace.sleep).toHaveBeenCalledTimes(2);
    await resources.retryFailedWorkspaceSleeps();
  });

  it("retries a failed workspace sleep with no active session", async () => {
    const remote = workspace();
    const botWorkspace = {
      ...localBotWorkspace(remote),
      provider: "vercel" as const,
      sleep: vi
        .fn()
        .mockRejectedValueOnce(new Error("pause unavailable"))
        .mockResolvedValue(undefined),
    };
    const resources = new AkeruSessionResources({
      stateDir: stateDir(),
      makeRemoteWorkspace: async () => botWorkspace,
      makeBotBrowser: () => browser(),
      toMcpServerConfigs: () => ({}),
    });

    await resources.acquire({ ...remoteInput, threadId: "idle-retry" });
    await expect(resources.release("idle-retry")).rejects.toThrow("pause unavailable");
    await resources.retryFailedWorkspaceSleeps();
    expect(botWorkspace.sleep).toHaveBeenCalledTimes(2);
    await resources.shutdown();
  });

  it("attributes shared browser failures and recovery to every active bot", async () => {
    const browserFailure = vi.fn();
    const browserReady = vi.fn();
    let onFailure!: (error: unknown) => void;
    let onReady!: () => void;
    const sharedBrowser = browser();
    const resources = new AkeruSessionResources({
      stateDir: stateDir(),
      makeBotBrowser: (input) => {
        onFailure = input.onFailure!;
        onReady = input.onReady!;
        return sharedBrowser;
      },
      onBrowserFailure: browserFailure,
      onBrowserReady: browserReady,
      toMcpServerConfigs: () => ({}),
    });
    const first = {
      ...remoteInput,
      botSandbox: null,
      threadId: "bot-a",
      botId: BotId.make("bot-a"),
      botName: "A",
      taskOrRoutine: "Task A",
    };
    const second = {
      ...remoteInput,
      botSandbox: null,
      threadId: "bot-b",
      botId: BotId.make("bot-b"),
      botName: "B",
      taskOrRoutine: "Task B",
    };
    await resources.acquire(first);
    await resources.acquire(second);
    onFailure(new Error("browser exited"));
    expect(browserFailure.mock.calls.map(([value]) => value.botId)).toEqual([
      first.botId,
      second.botId,
    ]);
    onReady();
    expect(browserReady.mock.calls.map(([botId]) => botId)).toEqual([first.botId, second.botId]);
    await resources.shutdown();
  });

  it("reports an active shared-browser failure to a bot that joins later", async () => {
    const browserFailure = vi.fn();
    const browserReady = vi.fn();
    let onFailure!: (error: unknown) => void;
    let onReady!: () => void;
    const resources = new AkeruSessionResources({
      stateDir: stateDir(),
      makeBotBrowser: (input) => {
        onFailure = input.onFailure!;
        onReady = input.onReady!;
        return browser();
      },
      onBrowserFailure: browserFailure,
      onBrowserReady: browserReady,
      toMcpServerConfigs: () => ({}),
    });
    const first = {
      ...remoteInput,
      botSandbox: null,
      threadId: "late-share-first",
      botId: BotId.make("late-share-first"),
    };
    const second = {
      ...remoteInput,
      botSandbox: null,
      threadId: "late-share-second",
      botId: BotId.make("late-share-second"),
    };
    await resources.acquire(first);
    onFailure(new Error("browser exited"));
    expect(browserFailure).toHaveBeenCalledOnce();
    await resources.acquire(second);
    expect(browserFailure.mock.calls.map(([input]) => input.botId)).toEqual([
      first.botId,
      second.botId,
    ]);
    onReady();
    expect(browserReady.mock.calls.map(([botId]) => botId)).toEqual([first.botId, second.botId]);
    await resources.shutdown();
  });

  it("does not pass a discarded browser failure to a replacement browser's bot", async () => {
    const browserFailure = vi.fn();
    const callbacks: Array<(error: unknown) => void> = [];
    const makeBotBrowser = vi.fn((input: { onFailure?: (error: unknown) => void }) => {
      callbacks.push(input.onFailure!);
      return browser();
    });
    const resources = new AkeruSessionResources({
      stateDir: stateDir(),
      makeBotBrowser,
      onBrowserFailure: browserFailure,
      toMcpServerConfigs: () => ({}),
    });
    const first = {
      ...remoteInput,
      botSandbox: null,
      threadId: "discarded-browser",
      botId: BotId.make("bot-a"),
    };
    const second = {
      ...first,
      threadId: "replacement-browser",
      botId: BotId.make("bot-b"),
    };

    await resources.acquire(first);
    callbacks[0]!(new Error("browser exited"));
    expect(browserFailure).toHaveBeenCalledOnce();
    await resources.release(first.threadId, { destroy: true });
    await resources.acquire(second);

    expect(makeBotBrowser).toHaveBeenCalledTimes(2);
    callbacks[0]!(new Error("old request rejected after replacement"));
    expect(browserFailure).toHaveBeenCalledOnce();
    await resources.shutdown();
  });

  it("retains attribution while another chat for the same bot is active", async () => {
    const browserFailure = vi.fn();
    let onFailure!: (error: unknown) => void;
    const resources = new AkeruSessionResources({
      stateDir: stateDir(),
      makeBotBrowser: (input) => {
        onFailure = input.onFailure!;
        return browser();
      },
      onBrowserFailure: browserFailure,
      toMcpServerConfigs: () => ({}),
    });
    const botId = BotId.make("bot-same");
    const first = { ...remoteInput, botSandbox: null, threadId: "chat-a", botId };
    const second = { ...remoteInput, botSandbox: null, threadId: "chat-b", botId };
    await resources.acquire(first);
    await resources.acquire(second);
    await resources.release(first.threadId);
    onFailure(new Error("browser exited"));
    expect(browserFailure).toHaveBeenCalledOnce();
    expect(browserFailure.mock.calls[0]?.[0].botId).toBe(botId);
    await resources.shutdown();
  });

  it.each(["local", "vercel", "e2b", "daytona", "upstash", "tenki"] as const)(
    "acquires only usable connector browser attachments in %s workspaces",
    async (botSandbox) => {
      for (const transport of ["stdio", "url"] as const) {
        for (const id of ["builtin-executor", "builtin-tinyfish", "builtin-exa", "raw-mcp"]) {
          const botBrowser = browser();
          const attachment = {
            browserUrl: "https://sandbox.example/browser",
            mcpSessionId: "session",
            requestHeaders: {},
            localRequestHeaders: {},
            availableToHostedPlugins: botSandbox !== "local",
          };
          const acquireAttachment = vi.fn(async () => attachment);
          const manager = mcpManager({ connected: true, toolCount: 1 });
          const toMcpServerConfigs = vi.fn(() => ({}));
          const resources = new AkeruSessionResources({
            stateDir: stateDir(),
            makeRemoteWorkspace: async () => workspace(),
            makeBotBrowser: () => ({ ...botBrowser, attachment: acquireAttachment }),
            makeMcpManager: () => manager as never,
            toMcpServerConfigs,
          });
          const server = {
            ...exaServer,
            id: McpServerId.make(id),
            transport,
            command: "connector",
          };
          try {
            await resources.acquire({
              ...remoteInput,
              botSandbox,
              threadId: "connector",
              mcpServers: [server, exaServer],
            });
            const requiresBrowser =
              botSandbox !== "tenki" &&
              (id === "builtin-executor" || id === "builtin-tinyfish") &&
              (transport === "stdio" || botSandbox !== "local");
            expect(acquireAttachment).toHaveBeenCalledTimes(requiresBrowser ? 1 : 0);
            expect(toMcpServerConfigs).toHaveBeenCalledWith(
              [server, exaServer],
              requiresBrowser ? attachment : undefined,
            );
            expect(manager.init).toHaveBeenCalledOnce();
          } finally {
            await resources.shutdown();
          }
        }
      }
    },
  );

  it("does no browser work for unrelated MCP startup and retains on-demand browser tools", async () => {
    const attachment = vi.fn(async () => undefined);
    const call = vi.fn(async () => "page tree");
    const close = vi.fn(async () => undefined);
    const resources = new AkeruSessionResources({
      stateDir: stateDir(),
      makeRemoteWorkspace: async () => workspace(),
      makeBotBrowser: (input) =>
        createBotBrowser({
          ...input,
          makeRpc: () => ({ attachment, call, close, reconnect: async () => undefined }),
        }),
      makeMcpManager: () => mcpManager({ connected: true, toolCount: 1 }) as never,
      toMcpServerConfigs: () => ({}),
    });
    try {
      await resources.acquire({ ...remoteInput, threadId: "lazy", mcpServers: [exaServer] });
      expect(attachment).not.toHaveBeenCalled();
      expect(call).not.toHaveBeenCalled();
      const tool = resources.getConnectorTools("lazy").browser_snapshot as {
        execute: (input: Record<string, unknown>) => Promise<unknown>;
      };
      await tool.execute({});
      expect(call).toHaveBeenCalledExactlyOnceWith("tree", {});
      expect(attachment).not.toHaveBeenCalled();
    } finally {
      await resources.shutdown();
    }
    expect(close).toHaveBeenCalledOnce();
  });

  it("does not advertise browser tools for Tenki while retaining MCP tools", async () => {
    const resources = new AkeruSessionResources({
      stateDir: stateDir(),
      makeRemoteWorkspace: async () => workspace(),
      makeBotBrowser: () => ({
        ...browser(),
        tools: createBotBrowserTools({
          call: async () => "",
          attachment: async () => undefined,
          reconnect: async () => undefined,
          close: async () => undefined,
        }),
      }),
      makeMcpManager: () =>
        mcpManager({ connected: true, toolCount: 1 }, { exa_search: {}, other_tool: {} }) as never,
      toMcpServerConfigs: () => ({}),
    });
    try {
      await resources.acquire({
        ...remoteInput,
        botSandbox: "tenki",
        threadId: "tenki-tools",
        mcpServers: [exaServer],
      });
      expect(resources.getConnectorTools("tenki-tools")).toEqual({
        exa_search: {},
        other_tool: {},
      });
    } finally {
      await resources.shutdown();
    }
  });

  it("preserves the Tenki workspace when MCP initialization fails", async () => {
    const remote: AkeruBotWorkspace = { ...localBotWorkspace(workspace()), provider: "tenki" };
    const destroy = vi.spyOn(remote, "destroy");
    const sleep = vi.spyOn(remote, "sleep");
    const manager = mcpManager({ connected: true, toolCount: 1 });
    manager.init.mockRejectedValueOnce(new Error("connector failed"));
    const resources = new AkeruSessionResources({
      stateDir: stateDir(),
      makeRemoteWorkspace: async () => remote,
      makeMcpManager: () => manager as never,
      toMcpServerConfigs: () => ({}),
    });

    await expect(
      resources.acquire({
        ...remoteInput,
        botSandbox: "tenki",
        threadId: "tenki-init-failure",
        mcpServers: [exaServer],
      }),
    ).rejects.toThrow("connector failed");
    expect(destroy).not.toHaveBeenCalled();
    expect(sleep).toHaveBeenCalledOnce();
    expect(manager.disconnect).toHaveBeenCalledOnce();
    const recovered = await resources.acquire({
      ...remoteInput,
      botSandbox: "tenki",
      threadId: "tenki-init-failure",
      mcpServers: [exaServer],
    });
    expect(recovered.botWorkspace).toBe(remote.workspace);
    await resources.shutdown();
    expect(destroy).not.toHaveBeenCalled();
  });

  it("coalesces concurrent acquisition for the same thread", async () => {
    const remote = workspace();
    const stop = vi.spyOn(remote, "stop");
    let finishCreate!: () => void;
    const created = new Promise<void>((resolve) => (finishCreate = resolve));
    const makeRemoteWorkspace = vi.fn(async () => {
      await created;
      return remote;
    });
    const resources = new AkeruSessionResources({
      stateDir: stateDir(),
      makeRemoteWorkspace,
      makeBotBrowser: () => browser(),
      toMcpServerConfigs: () => ({}),
    });

    const first = resources.acquire({ ...remoteInput, threadId: "same-thread" });
    const second = resources.acquire({ ...remoteInput, threadId: "same-thread" });
    finishCreate();
    const [firstView, secondView] = await Promise.all([first, second]);
    expect(firstView).toBe(secondView);
    expect(makeRemoteWorkspace).toHaveBeenCalledOnce();
    await resources.release("same-thread");
    expect(stop).toHaveBeenCalledOnce();
    await resources.shutdown();
  });

  it("reports MCP connection failures at the resource boundary", async () => {
    const onMcpServerConnectionFailure = vi.fn();
    const manager = {
      init: vi.fn(async () => undefined),
      disconnect: vi.fn(async () => undefined),
      getTools: vi.fn(() => ({})),
      getServerStatuses: vi.fn(() => [{ name: String(exaServer.id), connected: false }]),
    };
    const resources = new AkeruSessionResources({
      stateDir: stateDir(),
      makeRemoteWorkspace: async () => workspace(),
      makeBotBrowser: () => browser(),
      makeMcpManager: () => manager as never,
      onMcpServerConnectionFailure,
      toMcpServerConfigs: () => ({}),
    });

    await resources.acquire({ ...remoteInput, threadId: "mcp-failure", mcpServers: [exaServer] });
    expect(onMcpServerConnectionFailure).toHaveBeenCalledExactlyOnceWith(exaServer.id);
    await resources.shutdown();
  });

  it("exposes the authenticated product preview tools without a plugin connection", async () => {
    const previewStatus = { execute: vi.fn(async () => ({ attached: true })) };
    const previewSnapshot = { execute: vi.fn(async () => ({ url: "https://example.com" })) };
    const manager = {
      init: vi.fn(async () => undefined),
      disconnect: vi.fn(async () => undefined),
      getTools: vi.fn(() => ({
        akeru_preview_status: previewStatus,
        akeru_preview_snapshot: previewSnapshot,
      })),
      getServerStatuses: vi.fn(() => [
        {
          name: "akeru",
          connected: true,
          toolCount: 2,
          toolNames: ["akeru_preview_status", "akeru_preview_snapshot"],
        },
      ]),
    };
    const makeMcpManager = vi.fn(
      (_projectDir: string, _configDirName?: string, _servers?: Record<string, unknown>) =>
        manager as never,
    );
    const getPreviewMcpServerConfig = vi.fn(() => ({
      url: "http://127.0.0.1:4000/mcp",
      headers: { Authorization: "Bearer preview-token" },
    }));
    const botBrowser = browser();
    const resources = new AkeruSessionResources({
      stateDir: stateDir(),
      makeRemoteWorkspace: async () => workspace(),
      makeBotBrowser: () => botBrowser,
      makeMcpManager,
      getPreviewMcpServerConfig,
      toMcpServerConfigs: () => ({}),
    });

    await resources.acquire({ ...remoteInput, threadId: "preview-thread" });

    expect(getPreviewMcpServerConfig).toHaveBeenCalledExactlyOnceWith("preview-thread");
    expect(makeMcpManager).toHaveBeenCalledOnce();
    expect(makeMcpManager.mock.calls[0]?.[2]).toEqual({
      akeru: {
        url: "http://127.0.0.1:4000/mcp",
        headers: { Authorization: "Bearer preview-token" },
      },
    });
    expect(botBrowser.attachment).not.toHaveBeenCalled();
    expect(resources.getConnectorTools("preview-thread")).toEqual({
      preview_status: previewStatus,
      preview_snapshot: previewSnapshot,
    });

    await resources.shutdown();
  });

  it("reports every configured MCP server when manager initialization fails", async () => {
    const onMcpServerConnectionFailure = vi.fn();
    const manager = {
      init: vi.fn(async () => Promise.reject(new Error("MCP init failed"))),
      disconnect: vi.fn(async () => undefined),
      getTools: vi.fn(() => ({})),
      getServerStatuses: vi.fn(() => []),
    };
    const resources = new AkeruSessionResources({
      stateDir: stateDir(),
      makeRemoteWorkspace: async () => workspace(),
      makeBotBrowser: () => browser(),
      makeMcpManager: () => manager as never,
      onMcpServerConnectionFailure,
      toMcpServerConfigs: () => ({}),
    });

    await expect(
      resources.acquire({ ...remoteInput, threadId: "mcp-init-failure", mcpServers: [exaServer] }),
    ).rejects.toThrow("MCP init failed");
    expect(onMcpServerConnectionFailure).toHaveBeenCalledExactlyOnceWith(exaServer.id);
    await resources.shutdown();
  });

  it("removes a stale browser when reconnect fails", async () => {
    const firstBrowser = browser({
      reconnect: async () => Promise.reject(new Error("reconnect failed")),
    });
    const replacementBrowser = browser();
    const makeBotBrowser = vi
      .fn()
      .mockReturnValueOnce(firstBrowser)
      .mockReturnValueOnce(replacementBrowser);
    const resources = new AkeruSessionResources({
      stateDir: stateDir(),
      makeRemoteWorkspace: async () => localBotWorkspace(workspace()),
      makeBotBrowser,
      toMcpServerConfigs: () => ({}),
    });

    await resources.acquire({ ...remoteInput, threadId: "initial" });
    await resources.release("initial");
    await expect(
      resources.acquire({ ...remoteInput, threadId: "failed-reconnect" }),
    ).rejects.toThrow("reconnect failed");
    expect(firstBrowser.close).toHaveBeenCalledOnce();
    expect(
      (resources as unknown as { browserThreadBots: Map<string, string> }).browserThreadBots.has(
        "failed-reconnect",
      ),
    ).toBe(false);

    await resources.acquire({ ...remoteInput, threadId: "replacement" });
    expect(makeBotBrowser).toHaveBeenCalledTimes(2);
    await resources.shutdown();
    expect(replacementBrowser.close).toHaveBeenCalledOnce();
  });

  it("replaces the browser and workspace after sleep fails", async () => {
    const failed = workspace();
    vi.spyOn(failed, "stop").mockRejectedValueOnce(new Error("sleep failed"));
    const replacement = workspace();
    const makeRemoteWorkspace = vi
      .fn()
      .mockResolvedValueOnce(localBotWorkspace(failed))
      .mockResolvedValueOnce(localBotWorkspace(replacement));
    const staleBrowser = browser();
    const replacementBrowser = browser();
    const makeBotBrowser = vi
      .fn()
      .mockReturnValueOnce(staleBrowser)
      .mockReturnValueOnce(replacementBrowser);
    const resources = new AkeruSessionResources({
      stateDir: stateDir(),
      makeRemoteWorkspace,
      makeBotBrowser,
      toMcpServerConfigs: () => ({}),
    });

    await resources.acquire({ ...remoteInput, threadId: "failed-sleep" });
    await expect(resources.release("failed-sleep")).rejects.toThrow("sleep failed");
    expect(staleBrowser.close).toHaveBeenCalledOnce();

    const acquired = await resources.acquire({ ...remoteInput, threadId: "replacement" });
    expect(acquired.workspace).toBe(replacement);
    expect(makeRemoteWorkspace).toHaveBeenCalledTimes(2);
    expect(makeBotBrowser).toHaveBeenCalledTimes(2);
    await resources.shutdown();
  });

  it("does not leave closed browser tools after a shared reconnect fails", async () => {
    const staleBrowser = browser({
      reconnect: async () => Promise.reject(new Error("shared reconnect failed")),
    });
    const replacementBrowser = browser();
    const makeBotBrowser = vi
      .fn()
      .mockReturnValueOnce(staleBrowser)
      .mockReturnValueOnce(replacementBrowser);
    const resources = new AkeruSessionResources({
      stateDir: stateDir(),
      makeRemoteWorkspace: async () => localBotWorkspace(workspace()),
      makeBotBrowser,
      toMcpServerConfigs: () => ({}),
    });
    await resources.acquire({ ...remoteInput, threadId: "initial-shared" });
    await resources.release("initial-shared");

    const reconnects = [
      resources.acquire({ ...remoteInput, threadId: "shared-one" }),
      resources.acquire({ ...remoteInput, threadId: "shared-two" }),
    ];
    await Promise.all(
      reconnects.map((acquire) => expect(acquire).rejects.toThrow("shared reconnect failed")),
    );
    expect(staleBrowser.close).toHaveBeenCalledOnce();

    await resources.acquire({ ...remoteInput, threadId: "shared-replacement" });
    expect(makeBotBrowser).toHaveBeenCalledTimes(2);
    await resources.shutdown();
  });

  it("keeps a destroy request until the final shared browser release", async () => {
    const remote = workspace();
    const destroy = vi.spyOn(remote, "destroy");
    const sharedBrowser = browser();
    const resources = new AkeruSessionResources({
      stateDir: stateDir(),
      makeRemoteWorkspace: async () => localBotWorkspace(remote),
      makeBotBrowser: () => sharedBrowser,
      toMcpServerConfigs: () => ({}),
    });
    await resources.acquire({ ...remoteInput, threadId: "first" });
    await resources.acquire({ ...remoteInput, threadId: "second" });

    await resources.release("first", { destroy: true });
    expect(sharedBrowser.close).not.toHaveBeenCalled();
    expect(destroy).not.toHaveBeenCalled();
    await resources.release("second");
    expect(sharedBrowser.close).toHaveBeenCalledOnce();
    expect(destroy).toHaveBeenCalledOnce();
    await resources.shutdown();
  });

  it("stops pooled workspaces and browsers during shutdown", async () => {
    const remote = workspace();
    const stop = vi.spyOn(remote, "stop");
    const destroy = vi.spyOn(remote, "destroy");
    const sharedBrowser = browser();
    const resources = new AkeruSessionResources({
      stateDir: stateDir(),
      makeRemoteWorkspace: async () => localBotWorkspace(remote),
      makeBotBrowser: () => sharedBrowser,
      toMcpServerConfigs: () => ({}),
    });
    await resources.acquire({ ...remoteInput, threadId: "shutdown" });
    await resources.release("shutdown");
    expect(stop).toHaveBeenCalledOnce();

    await resources.shutdown();
    expect(destroy).not.toHaveBeenCalled();
    expect(sharedBrowser.close).toHaveBeenCalledOnce();
    await expect(resources.acquire({ ...remoteInput, threadId: "late" })).rejects.toThrow(
      "shutting down",
    );
  });

  it("reattaches a durable remote workspace after shutdown", async () => {
    const directory = stateDir();
    const sleep = vi.fn(async () => undefined);
    const destroy = vi.fn(async () => undefined);
    const openSession = vi.fn(
      async (providerId?: string): Promise<AkeruRemoteSession> => ({
        providerId: providerId ?? "provider-1",
        inspect: async () => "running",
        run: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
        browserEndpoint: async () => ({ url: "https://browser.example", requestHeaders: {} }),
        wake: async () => undefined,
        sleep,
        destroy,
      }),
    );
    const options = {
      stateDir: directory,
      makeRemoteWorkspace: (input: Parameters<typeof createRemoteBotWorkspace>[0]) =>
        createRemoteBotWorkspace({ ...input, openSession }),
      toMcpServerConfigs: () => ({}),
    };

    const first = new AkeruSessionResources(options);
    await first.acquire({ ...remoteInput, threadId: "before-restart" });
    await first.shutdown();

    expect(sleep).toHaveBeenCalledOnce();
    expect(destroy).not.toHaveBeenCalled();
    const identityFile = NodePath.join(
      directory,
      "bot-workspaces",
      remoteInput.workspaceId,
      "provider.json",
    );
    expect(NodeFS.existsSync(identityFile)).toBe(true);

    const second = new AkeruSessionResources(options);
    await second.acquire({ ...remoteInput, threadId: "after-restart" });
    expect(openSession).toHaveBeenNthCalledWith(2, "provider-1");
    await second.release("after-restart", { destroy: true });
    expect(destroy).toHaveBeenCalledOnce();
    expect(NodeFS.existsSync(identityFile)).toBe(false);
  });

  it("keeps the bot workspace separate from the user computer workspace", async () => {
    const directory = stateDir();
    const project = NodePath.join(directory, "project");
    NodeFS.mkdirSync(project, { recursive: true });
    const resources = new AkeruSessionResources({
      stateDir: directory,
      makeBotBrowser: () => browser(),
      toMcpServerConfigs: () => ({}),
    });
    const acquired = await resources.acquire({
      threadId: "local-thread",
      resourceScope: "bot-one",
      workspaceResourceKey: "local:bot-one",
      workspaceId: "akeru-bot-one",
      botSandbox: "local",
      userComputerCwd: project,
      mcpServers: [],
    });
    await acquired.botWorkspace.filesystem?.writeFile("bot.txt", "bot");
    await acquired.workspace.filesystem?.writeFile("user.txt", "user");
    expect(resources.getWorkspace("local-thread")).toBe(acquired.workspace);
    expect(
      NodeFS.existsSync(NodePath.join(directory, "bot-workspaces", "akeru-bot-one", "bot.txt")),
    ).toBe(true);
    expect(NodeFS.existsSync(NodePath.join(project, "user.txt"))).toBe(true);
    expect(NodeFS.existsSync(NodePath.join(project, "bot.txt"))).toBe(false);
    await resources.shutdown();
  });

  it("allows one Computer Use controller and releases it on stop without a browser attachment", async () => {
    const manager = mcpManager({ connected: true, toolCount: 1 });
    const botBrowser = browser();
    const resources = new AkeruSessionResources({
      stateDir: stateDir(),
      hostPlatform: "darwin",
      makeRemoteWorkspace: async () => workspace(),
      makeBotBrowser: () => botBrowser,
      makeMcpManager: () => manager as never,
      resolveComputerUseServer: async () => ({
        command: "/local/launcher",
        args: ["mcp"],
        env: {},
      }),
      toMcpServerConfigs: () => ({
        [CODEX_COMPUTER_USE_SERVER_ID]: { command: "sentinel" },
      }),
    });
    const input = { ...remoteInput, mcpServers: [computerServer()] };

    await resources.acquire({ ...input, threadId: "controller" });
    await expect(resources.acquire({ ...input, threadId: "blocked" })).rejects.toThrow(
      "already controlled",
    );
    await resources.release("controller");
    await resources.acquire({ ...input, threadId: "replacement" });
    expect(botBrowser.attachment).not.toHaveBeenCalled();
    await resources.shutdown();
  });

  it("redacts Computer Use results at the MCP tool boundary", async () => {
    const execute = vi.fn(async () => ({ screenshot: { url: "https://example.com/frame.png" } }));
    const toolName = `${CODEX_COMPUTER_USE_SERVER_ID}_control`;
    const manager = mcpManager({ connected: true, toolCount: 1 }, { [toolName]: { execute } });
    const resources = new AkeruSessionResources({
      stateDir: stateDir(),
      hostPlatform: "darwin",
      makeRemoteWorkspace: async () => workspace(),
      makeBotBrowser: () => browser(),
      makeMcpManager: () => manager as never,
      resolveComputerUseServer: async () => ({
        command: "/local/launcher",
        args: ["mcp"],
        env: {},
      }),
      toMcpServerConfigs: () => ({
        [CODEX_COMPUTER_USE_SERVER_ID]: { command: "sentinel" },
      }),
    });

    await resources.acquire({
      ...remoteInput,
      threadId: "controller",
      mcpServers: [computerServer()],
    });
    const tool = Reflect.get(resources.getConnectorTools("controller"), toolName) as {
      execute: () => Promise<unknown>;
    };
    await expect(tool.execute()).rejects.toThrow("unknown screenshot");
    expect(execute).toHaveBeenCalledOnce();
    await resources.shutdown();
  });

  it("keeps remote browser tools lazy for a connector without browser dependencies", async () => {
    const browserEndpoint = vi.fn(async () => ({
      url: "https://browser.example",
      requestHeaders: { authorization: "Bearer token" },
    }));
    const remote: AkeruBotWorkspace = {
      id: "akeru-shared",
      provider: "vercel",
      providerId: "vercel-native-id",
      workspace: workspace(),
      browserEndpoint,
      inspect: async () => "running",
      wake: vi.fn(async () => undefined),
      sleep: vi.fn(async () => undefined),
      destroy: vi.fn(async () => undefined),
    };
    const manager = {
      init: vi.fn(async () => undefined),
      disconnect: vi.fn(async () => undefined),
      getTools: vi.fn(() => ({ exa_search: {} })),
      getServerStatuses: vi.fn(() => []),
    };
    const remoteBrowser = browser();
    const makeBotBrowser = vi.fn(() => remoteBrowser);
    const toMcpServerConfigs = vi.fn(() => ({}));
    const resources = new AkeruSessionResources({
      stateDir: stateDir(),
      makeRemoteWorkspace: async () => remote,
      makeBotBrowser,
      makeMcpManager: vi.fn(() => manager as never),
      toMcpServerConfigs,
    });

    await resources.acquire({
      ...remoteInput,
      threadId: "remote-mcp",
      mcpServers: [
        {
          id: McpServerId.make("builtin-exa"),
          name: "Exa",
          transport: "url",
          url: "https://mcp.exa.ai/mcp",
          enabled: true,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    });

    expect(makeBotBrowser).toHaveBeenCalledWith(
      expect.objectContaining({ browserEndpoint, workspace: remote.workspace }),
    );
    expect(remoteBrowser.attachment).not.toHaveBeenCalled();
    expect(toMcpServerConfigs).toHaveBeenCalledWith(expect.any(Array), undefined);
    expect(resources.getConnectorTools("remote-mcp")).toEqual({ exa_search: {} });
    await resources.shutdown();
  });

  it("releases the Computer Use lock when MCP health fails", async () => {
    const failed = mcpManager({ connected: false, toolCount: 0, error: "Accessibility denied" });
    const healthy = mcpManager({ connected: true, toolCount: 1 });
    const makeMcpManager = vi
      .fn()
      .mockReturnValueOnce(failed as never)
      .mockReturnValueOnce(healthy as never);
    const resources = new AkeruSessionResources({
      stateDir: stateDir(),
      hostPlatform: "darwin",
      makeRemoteWorkspace: async () => workspace(),
      makeBotBrowser: () => browser(),
      makeMcpManager,
      resolveComputerUseServer: async () => ({
        command: "/local/launcher",
        args: ["mcp"],
        env: {},
      }),
      toMcpServerConfigs: () => ({
        [CODEX_COMPUTER_USE_SERVER_ID]: { command: "sentinel" },
      }),
    });
    const input = { ...remoteInput, mcpServers: [computerServer()] };

    await expect(resources.acquire({ ...input, threadId: "failed" })).rejects.toThrow(
      "needs Screen Recording and Accessibility permissions",
    );
    await resources.acquire({ ...input, threadId: "replacement" });
    await resources.shutdown();
  });

  it("does not expose raw MCP startup errors", async () => {
    const failed = mcpManager({
      connected: false,
      toolCount: 0,
      error: "Failed at /private/tester/Secret App",
    });
    const resources = new AkeruSessionResources({
      stateDir: stateDir(),
      hostPlatform: "darwin",
      makeRemoteWorkspace: async () => workspace(),
      makeBotBrowser: () => browser(),
      makeMcpManager: () => failed as never,
      resolveComputerUseServer: async () => ({
        command: "/local/launcher",
        args: ["mcp"],
        env: {},
      }),
      toMcpServerConfigs: () => ({
        [CODEX_COMPUTER_USE_SERVER_ID]: { command: "sentinel" },
      }),
    });

    await expect(
      resources.acquire({
        ...remoteInput,
        threadId: "failed",
        mcpServers: [computerServer()],
      }),
    ).rejects.toThrow("Computer Use MCP failed to start.");
    await resources.shutdown();
  });
  it("registers exclusive computers only when requested and unregisters on release", async () => {
    const graphical = new WorkspaceComputer(
      "daytona-id",
      {
        open: async () => undefined,
        input: async () => undefined,
        capture: async () => ({ mimeType: "image/jpeg", data: "Zg==", width: 2, height: 2 }),
      },
      async () => undefined,
      async () => ({ url: "http://127.0.0.1:9222", requestHeaders: {} }),
      async () => "running",
    );
    const resources = new AkeruSessionResources({
      stateDir: stateDir(),
      makeRemoteWorkspace: async () => ({
        ...localBotWorkspace(workspace()),
        computer: graphical,
      }),
      makeBotBrowser: () => browser(),
      toMcpServerConfigs: () => ({}),
    });

    await resources.acquire({ ...remoteInput, threadId: "legacy" });
    expect(computerRegistry.state(ThreadId.make("legacy")).capability).toBe("none");
    await resources.release("legacy");

    await resources.acquire({ ...remoteInput, threadId: "codex", exclusiveComputer: true });
    expect(computerRegistry.state(ThreadId.make("codex"))).toMatchObject({
      capability: "desktop",
      controlAvailable: true,
      workspaceId: "daytona-id",
    });
    await resources.release("codex");
    expect(computerRegistry.state(ThreadId.make("codex")).capability).toBe("none");
    await resources.shutdown();
  });
});
