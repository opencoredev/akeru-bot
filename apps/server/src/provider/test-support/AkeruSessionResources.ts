// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { LocalFilesystem, LocalSandbox, Workspace } from "@mastra/core/workspace";
import { McpServerId } from "@akeru/contracts";
import { vi } from "vite-plus/test";
import { CODEX_COMPUTER_USE_SERVER_ID } from "../CodexComputerUse.ts";
import { type AkeruBotWorkspace } from "../botWorkspace.ts";

export function makeAkeruSessionResourcesTestSupport() {
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
    tools: Record<string, Pick<import("@mastra/core/tools").Tool, "execute">> = {},
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

  return {
    directories,
    stateDir,
    workspace,
    localBotWorkspace,
    browser,
    computerServer,
    mcpManager,
    remoteInput,
    exaServer,
  };
}
