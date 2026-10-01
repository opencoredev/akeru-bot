import { describe } from "vite-plus/test";
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { McpServerId } from "@akeru/contracts";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { AkeruSessionResources } from "./AkeruSessionResources.ts";
import { createBotBrowserTools } from "./botBrowser.ts";
import { CODEX_COMPUTER_USE_SERVER_ID } from "./CodexComputerUse.ts";
import { createBotBrowser } from "./botBrowser.ts";
import {
  botWorkspaceCredentialFingerprint,
  botWorkspaceIdentity,
  botWorkspaceResourceKey,
} from "./botWorkspacePool.ts";
import {
  type AkeruBotWorkspace,
  type AkeruRemoteSession,
  createRemoteBotWorkspace,
} from "./botWorkspace.ts";
import { makeAkeruSessionResourcesTestSupport } from "./test-support/AkeruSessionResources.ts";

const {
  directories,
  stateDir,
  workspace,
  localBotWorkspace,
  browser,
  computerServer,
  mcpManager,
  remoteInput,
  exaServer,
} = makeAkeruSessionResourcesTestSupport();

describe("AkeruSessionResources", () => {
  afterEach(() => {
    for (const directory of directories) {
      NodeFS.rmSync(directory, { recursive: true, force: true });
    }
    directories.clear();
  });

  it.each(["local", "vercel", "e2b", "daytona", "upstash", "railway", "tenki"] as const)(
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
            const requiresBrowser =
              botSandbox !== "tenki" &&
              (id === "builtin-executor" || id === "builtin-tinyfish") &&
              (transport === "stdio" || botSandbox !== "local");
            if (botSandbox === "railway" && requiresBrowser) {
              await expect(
                resources.acquire({
                  ...remoteInput,
                  botSandbox,
                  threadId: "connector",
                  mcpServers: [server, exaServer],
                }),
              ).rejects.toThrow("Railway CLI tunnel");
              expect(acquireAttachment).not.toHaveBeenCalled();
              expect(manager.init).not.toHaveBeenCalled();
              continue;
            }
            await resources.acquire({
              ...remoteInput,
              botSandbox,
              threadId: "connector",
              mcpServers: [server, exaServer],
            });
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

  it("preserves the Ascii workspace when MCP initialization fails", async () => {
    const remote: AkeruBotWorkspace = { ...localBotWorkspace(workspace()), provider: "ascii" };
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
        botSandbox: "ascii",
        threadId: "ascii-init-failure",
        mcpServers: [exaServer],
      }),
    ).rejects.toThrow("connector failed");
    expect(destroy).not.toHaveBeenCalled();
    expect(sleep).toHaveBeenCalledOnce();
    expect(manager.disconnect).toHaveBeenCalledOnce();
    const recovered = await resources.acquire({
      ...remoteInput,
      botSandbox: "ascii",
      threadId: "ascii-init-failure",
      mcpServers: [exaServer],
    });
    expect(recovered.botWorkspace).toBe(remote.workspace);
    await resources.shutdown();
    expect(destroy).not.toHaveBeenCalled();
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

  it("reattaches Railway after credential rotation and rejects browser connectors without touching the VM", async () => {
    const directory = stateDir();
    const destroy = vi.fn(async () => undefined);
    const openSession = vi.fn(
      async (providerId?: string): Promise<AkeruRemoteSession> => ({
        providerId: providerId ?? "railway-vm",
        inspect: async () => "running",
        run: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
        browserEndpoint: async () => {
          throw new Error("Railway CLI tunnel required");
        },
        wake: async () => undefined,
        sleep: async () => undefined,
        destroy,
      }),
    );
    const makeRemoteWorkspace = vi.fn((input: Parameters<typeof createRemoteBotWorkspace>[0]) =>
      createRemoteBotWorkspace({ ...input, openSession }),
    );
    const failedManager = mcpManager({ connected: true, toolCount: 0 });
    failedManager.init.mockRejectedValueOnce(new Error("MCP init failed after rotation"));
    const resources = new AkeruSessionResources({
      stateDir: directory,
      makeRemoteWorkspace,
      makeMcpManager: () => failedManager as never,
      toMcpServerConfigs: () => ({}),
    });
    const input = (token: string) => {
      const sandboxEnvironment = {
        RAILWAY_API_TOKEN: token,
        RAILWAY_ENVIRONMENT_ID: "environment",
      };
      const workspaceResourceKey = botWorkspaceResourceKey({
        sandbox: "railway",
        resourceScope: "bot-one",
        credentialFingerprint: botWorkspaceCredentialFingerprint(sandboxEnvironment),
      });
      return {
        ...remoteInput,
        botSandbox: "railway" as const,
        sandboxEnvironment,
        threadId: token,
        workspaceResourceKey,
        workspaceId: botWorkspaceIdentity(workspaceResourceKey),
        mcpServers: [],
      };
    };
    const first = input("old-token");
    const second = input("new-token");
    await resources.acquire(first);
    await resources.acquire(second);
    expect(openSession).toHaveBeenNthCalledWith(1, undefined);
    expect(openSession).toHaveBeenNthCalledWith(2, "railway-vm");
    await resources.release(second.threadId);
    const identityFile = NodePath.join(
      directory,
      "bot-workspaces",
      first.workspaceId,
      "provider.json",
    );
    const identity = NodeFS.readFileSync(identityFile, "utf8");
    await expect(
      resources.acquire({
        ...second,
        threadId: "connector",
        mcpServers: [
          {
            ...exaServer,
            id: McpServerId.make("builtin-tinyfish"),
            transport: "stdio",
            command: "connector",
          },
        ],
      }),
    ).rejects.toThrow("Railway CLI tunnel");
    expect(makeRemoteWorkspace).toHaveBeenCalledTimes(2);
    expect(destroy).not.toHaveBeenCalled();
    expect(NodeFS.readFileSync(identityFile, "utf8")).toBe(identity);
    await expect(
      resources.acquire({ ...input("another-token"), mcpServers: [exaServer] }),
    ).rejects.toThrow("MCP init failed after rotation");
    expect(destroy).not.toHaveBeenCalled();
    expect(resources.getWorkspace(first.threadId)).toBeDefined();
    expect(NodeFS.readFileSync(identityFile, "utf8")).toBe(identity);
    await resources.shutdown();
    const restarted = new AkeruSessionResources({
      stateDir: directory,
      makeRemoteWorkspace,
      toMcpServerConfigs: () => ({}),
    });
    openSession.mockRejectedValueOnce(new Error("credentials revoked"));
    await expect(restarted.acquire(input("revoked-token"))).rejects.toThrow(
      "missing or unavailable",
    );
    expect(openSession).toHaveBeenLastCalledWith("railway-vm");
    expect(NodeFS.readFileSync(identityFile, "utf8")).toBe(identity);
    expect(destroy).not.toHaveBeenCalled();
    await restarted.shutdown();
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
