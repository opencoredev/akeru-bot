// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { LocalFilesystem, LocalSandbox, Workspace } from "@mastra/core/workspace";
import { McpServerId } from "@t3tools/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { AkeruSessionResources } from "./AkeruSessionResources.ts";
import { CODEX_COMPUTER_USE_SERVER_ID } from "./CodexComputerUse.ts";
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

  it("allows one Computer Use controller and releases it on stop", async () => {
    const manager = mcpManager({ connected: true, toolCount: 1 });
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
    const input = { ...remoteInput, mcpServers: [computerServer()] };

    await resources.acquire({ ...input, threadId: "controller" });
    await expect(resources.acquire({ ...input, threadId: "blocked" })).rejects.toThrow(
      "already controlled",
    );
    await resources.release("controller");
    await resources.acquire({ ...input, threadId: "replacement" });
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

  it("creates and attaches a browser for remote workspaces", async () => {
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
    expect(remoteBrowser.attachment).toHaveBeenCalledOnce();
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
});
