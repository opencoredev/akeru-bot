// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import type { ToolsInput } from "@mastra/core/agent";
import {
  createMcpManager,
  type McpManager,
  type McpServerConfig,
} from "@mastra/code-sdk/mcp/index";
import type { Workspace } from "@mastra/core/workspace";
import type { BotSandbox, McpServer } from "@t3tools/contracts";

import {
  createBotBrowser,
  type BotBrowser,
  type BotBrowserAttachment,
  type CreateBotBrowserInput,
} from "./botBrowser.ts";
import {
  type AkeruBotWorkspace,
  createBotWorkspace,
  isRemoteBotSandbox,
  type CreateRemoteBotWorkspaceInput,
} from "./botWorkspace.ts";
import { BotWorkspacePool, type BotWorkspaceLease } from "./botWorkspacePool.ts";
import {
  CODEX_COMPUTER_USE_SERVER_ID,
  isCodexComputerUseServer,
  isCodexComputerUseTool,
  resolveCodexComputerUseServer,
  sanitizeCodexComputerUseResult,
} from "./CodexComputerUse.ts";

export interface AkeruSessionResourceInput {
  readonly threadId: string;
  readonly resourceScope: string;
  readonly workspaceResourceKey: string;
  readonly workspaceId: string;
  readonly botSandbox?: BotSandbox | null;
  readonly userComputerCwd?: string;
  readonly mcpServers: readonly McpServer[];
}

export interface AkeruSessionResourceView {
  readonly workspace: Workspace;
  readonly botWorkspace: Workspace;
}

export interface AkeruSessionResourcesOptions {
  readonly stateDir: string;
  readonly makeMcpManager?: typeof createMcpManager;
  readonly makeRemoteWorkspace?: (
    input: CreateRemoteBotWorkspaceInput,
  ) => Promise<AkeruBotWorkspace | Workspace>;
  readonly makeBotBrowser?: (input: CreateBotBrowserInput) => BotBrowser;
  readonly hostPlatform?: NodeJS.Platform;
  readonly resolveComputerUseServer?: typeof resolveCodexComputerUseServer;
  readonly onMcpServerConnectionFailure?: (serverId: McpServer["id"]) => void;
  readonly toMcpServerConfigs: (
    servers: readonly McpServer[],
    browser?: BotBrowserAttachment,
  ) => Record<string, McpServerConfig>;
}

export class AkeruSessionResources {
  private readonly options: AkeruSessionResourcesOptions;
  private readonly acquisitions = new Map<string, Promise<AkeruSessionResourceView>>();
  private readonly mcpManagers = new Map<string, McpManager>();
  private readonly workspaceLeases = new Map<string, BotWorkspaceLease>();
  private readonly userComputerWorkspaceLeases = new Map<string, BotWorkspaceLease>();
  private readonly workspacePool = new BotWorkspacePool();
  private readonly threadBrowsers = new Map<string, BotBrowser>();
  private readonly browserResourceKeys = new Map<string, string>();
  private readonly resourceBrowsers = new Map<string, BotBrowser>();
  private readonly browserReferences = new Map<string, number>();
  private readonly browserDestroyRequests = new Set<string>();
  private readonly browserReconnects = new Map<string, Promise<void>>();
  private readonly computerUseTemporaryDirectories = new Map<string, string>();
  private controllingThreadId: string | undefined;
  private shuttingDown = false;

  constructor(options: AkeruSessionResourcesOptions) {
    this.options = options;
  }

  acquire(input: AkeruSessionResourceInput): Promise<AkeruSessionResourceView> {
    if (this.shuttingDown) {
      return Promise.reject(new Error("Akeru session resources are shutting down."));
    }
    const pending = this.acquisitions.get(input.threadId);
    if (pending) return pending;
    if (this.workspaceLeases.has(input.threadId)) {
      return Promise.reject(
        new Error(`Resources are already acquired for thread '${input.threadId}'.`),
      );
    }

    const acquisition = this.acquireOnce(input).finally(() => {
      if (this.acquisitions.get(input.threadId) === acquisition) {
        this.acquisitions.delete(input.threadId);
      }
    });
    this.acquisitions.set(input.threadId, acquisition);
    return acquisition;
  }

  private async acquireOnce(input: AkeruSessionResourceInput): Promise<AkeruSessionResourceView> {
    const key = input.threadId;
    const usesComputer = input.mcpServers.some((server) =>
      isCodexComputerUseServer(String(server.id)),
    );
    try {
      if (usesComputer) {
        if (this.controllingThreadId && this.controllingThreadId !== key) {
          throw new Error(
            `Computer Use is already controlled by thread '${this.controllingThreadId}'. Stop it before starting another controller.`,
          );
        }
        this.controllingThreadId = key;
      }
      const workspaceLease = await this.workspacePool.acquire(
        input.workspaceResourceKey,
        async () => {
          const workspace = await createBotWorkspace({
            threadId: input.resourceScope,
            workspaceId: input.workspaceId,
            identityFile: NodePath.join(
              this.options.stateDir,
              "bot-workspaces",
              input.workspaceId,
              "provider.json",
            ),
            ...(isRemoteBotSandbox(input.botSandbox)
              ? { sandbox: input.botSandbox }
              : {
                  sandbox: "local" as const,
                  localRoot: NodePath.join(
                    this.options.stateDir,
                    "bot-workspaces",
                    input.workspaceId,
                  ),
                }),
            ...(this.options.makeRemoteWorkspace
              ? { makeRemoteWorkspace: this.options.makeRemoteWorkspace }
              : {}),
          });
          if (!workspace) throw new Error(`Workspace is unavailable for thread '${key}'.`);
          return workspace;
        },
      );
      this.workspaceLeases.set(key, workspaceLease);

      const remote = isRemoteBotSandbox(input.botSandbox);
      const userComputerCwd = remote ? undefined : input.userComputerCwd;
      const userComputerWorkspaceLease = userComputerCwd
        ? await this.workspacePool.acquire(`user-computer:${key}:${userComputerCwd}`, async () => {
            const workspace = await createBotWorkspace({
              threadId: `user-computer-${key}`,
              cwd: userComputerCwd,
            });
            if (!workspace) {
              throw new Error(`User computer is unavailable for thread '${key}'.`);
            }
            return workspace;
          })
        : undefined;
      if (userComputerWorkspaceLease) {
        this.userComputerWorkspaceLeases.set(key, userComputerWorkspaceLease);
      }

      const existingBrowser = this.resourceBrowsers.get(input.workspaceResourceKey);
      const browser =
        existingBrowser ??
        (this.options.makeBotBrowser ?? createBotBrowser)({
          threadId: input.resourceScope,
          workspace: workspaceLease.workspace.workspace,
          cacheDir: NodePath.join(this.options.stateDir, "bot-browser-runtime"),
          ...(workspaceLease.workspace.browserEndpoint
            ? { browserEndpoint: workspaceLease.workspace.browserEndpoint }
            : {}),
        });

      this.resourceBrowsers.set(input.workspaceResourceKey, browser);
      this.threadBrowsers.set(key, browser);
      this.browserResourceKeys.set(key, input.workspaceResourceKey);
      this.browserReferences.set(
        input.workspaceResourceKey,
        (this.browserReferences.get(input.workspaceResourceKey) ?? 0) + 1,
      );

      let reconnect = this.browserReconnects.get(input.workspaceResourceKey);
      if (existingBrowser && workspaceLease.wokeFromSleep && !reconnect) {
        reconnect = browser.reconnect().finally(() => {
          this.browserReconnects.delete(input.workspaceResourceKey);
        });
        this.browserReconnects.set(input.workspaceResourceKey, reconnect);
      }
      try {
        await reconnect;
      } catch (cause) {
        await this.invalidateBrowser(input.workspaceResourceKey, browser);
        throw cause;
      }

      if (input.mcpServers.length > 0) {
        const attachment = await browser.attachment();
        const configs = this.options.toMcpServerConfigs(input.mcpServers, attachment);
        if (usesComputer) {
          if (!this.options.hostPlatform) {
            throw new Error("Computer Use host platform is unavailable.");
          }
          const config = await (
            this.options.resolveComputerUseServer ?? resolveCodexComputerUseServer
          )({ platform: this.options.hostPlatform });
          configs[CODEX_COMPUTER_USE_SERVER_ID] = config;
          const temporaryDirectory = config.env?.TMPDIR;
          if (typeof temporaryDirectory === "string") {
            this.computerUseTemporaryDirectories.set(key, temporaryDirectory);
          }
        }
        const manager = (this.options.makeMcpManager ?? createMcpManager)(
          NodePath.join(this.options.stateDir, "bot-mcp-runtime"),
          ".akeru-runtime",
          configs,
        );
        this.mcpManagers.set(key, manager);
        try {
          await manager.init();
        } catch (cause) {
          for (const server of input.mcpServers) {
            this.options.onMcpServerConnectionFailure?.(server.id);
          }
          if (usesComputer) {
            // eslint-disable-next-line preserve-caught-error -- MCP errors may contain private desktop paths.
            throw new Error("Computer Use MCP failed to start.");
          }
          throw cause;
        }
        const serversById = new Map(input.mcpServers.map((server) => [String(server.id), server]));
        for (const status of manager.getServerStatuses()) {
          if (status.connected) continue;
          const server = serversById.get(status.name);
          if (server) this.options.onMcpServerConnectionFailure?.(server.id);
        }
        if (usesComputer) {
          const status = manager
            .getServerStatuses()
            .find((server) => server.name === CODEX_COMPUTER_USE_SERVER_ID);
          if (!status?.connected || status.toolCount === 0) {
            if (/screen recording|accessibility/i.test(status?.error ?? "")) {
              throw new Error("Computer Use needs Screen Recording and Accessibility permissions.");
            }
            throw new Error("Computer Use MCP failed to start.");
          }
        }
      }

      return {
        workspace:
          userComputerWorkspaceLease?.workspace.workspace ?? workspaceLease.workspace.workspace,
        botWorkspace: workspaceLease.workspace.workspace,
      };
    } catch (cause) {
      await this.releaseOnce(key, { destroy: true }).catch(() => undefined);
      throw cause;
    }
  }

  getConnectorTools(threadId: string): ToolsInput {
    const tools: ToolsInput = {
      ...this.threadBrowsers.get(threadId)?.tools,
      ...this.mcpManagers.get(threadId)?.getTools(),
    };
    return Object.fromEntries(
      Object.entries(tools).map(([name, tool]) => {
        const execute = Reflect.get(tool, "execute") as unknown;
        if (!isCodexComputerUseTool(name) || typeof execute !== "function") {
          return [name, tool];
        }
        return [
          name,
          {
            ...tool,
            execute: async (...args: readonly unknown[]) => {
              const temporaryDirectory = this.computerUseTemporaryDirectories.get(threadId);
              return sanitizeCodexComputerUseResult(
                await Reflect.apply(execute, tool, args),
                temporaryDirectory ? { temporaryDirectory } : undefined,
              );
            },
          },
        ];
      }),
    );
  }

  getWorkspace(threadId: string): Workspace | undefined {
    return (
      this.userComputerWorkspaceLeases.get(threadId)?.workspace.workspace ??
      this.workspaceLeases.get(threadId)?.workspace.workspace
    );
  }

  async release(threadId: string, options?: { readonly destroy?: boolean }): Promise<void> {
    await this.acquisitions.get(threadId)?.catch(() => undefined);
    await this.releaseOnce(threadId, options);
  }

  private async releaseOnce(
    threadId: string,
    options?: { readonly destroy?: boolean },
  ): Promise<void> {
    const failures: unknown[] = [];
    const manager = this.mcpManagers.get(threadId);
    this.mcpManagers.delete(threadId);
    if (manager) await manager.disconnect().catch((cause) => failures.push(cause));
    const computerUseTemporaryDirectory = this.computerUseTemporaryDirectories.get(threadId);
    this.computerUseTemporaryDirectories.delete(threadId);
    if (computerUseTemporaryDirectory) {
      try {
        NodeFS.rmSync(computerUseTemporaryDirectory, { recursive: true, force: true });
      } catch (cause) {
        failures.push(cause);
      }
    }

    const browser = this.threadBrowsers.get(threadId);
    const resourceKey = this.browserResourceKeys.get(threadId);
    this.threadBrowsers.delete(threadId);
    this.browserResourceKeys.delete(threadId);
    if (browser && resourceKey) {
      if (options?.destroy) this.browserDestroyRequests.add(resourceKey);
      const references = Math.max(0, (this.browserReferences.get(resourceKey) ?? 1) - 1);
      if (references > 0) {
        this.browserReferences.set(resourceKey, references);
      } else {
        this.browserReferences.delete(resourceKey);
        if (
          this.browserDestroyRequests.delete(resourceKey) &&
          this.resourceBrowsers.get(resourceKey) === browser
        ) {
          this.resourceBrowsers.delete(resourceKey);
          await browser.close().catch((cause) => failures.push(cause));
        }
      }
    }

    const workspaceLease = this.workspaceLeases.get(threadId);
    this.workspaceLeases.delete(threadId);
    if (workspaceLease) {
      await workspaceLease.release(options).catch(async (cause) => {
        failures.push(cause);
        if (browser && resourceKey) await this.invalidateBrowser(resourceKey, browser);
      });
    }
    const userComputerLease = this.userComputerWorkspaceLeases.get(threadId);
    this.userComputerWorkspaceLeases.delete(threadId);
    if (userComputerLease) {
      await userComputerLease.release(options).catch((cause) => failures.push(cause));
    }
    if (this.controllingThreadId === threadId) this.controllingThreadId = undefined;
    if (failures.length > 0) throw failures[0];
  }

  private async invalidateBrowser(resourceKey: string, browser: BotBrowser): Promise<void> {
    if (this.resourceBrowsers.get(resourceKey) !== browser) return;
    this.resourceBrowsers.delete(resourceKey);
    this.browserReferences.delete(resourceKey);
    this.browserDestroyRequests.delete(resourceKey);
    for (const [threadId, key] of this.browserResourceKeys) {
      if (key !== resourceKey) continue;
      this.browserResourceKeys.delete(threadId);
      this.threadBrowsers.delete(threadId);
    }
    await browser.close().catch(() => undefined);
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    await Promise.allSettled(this.acquisitions.values());
    const threadIds = new Set([
      ...this.acquisitions.keys(),
      ...this.workspaceLeases.keys(),
      ...this.userComputerWorkspaceLeases.keys(),
      ...this.mcpManagers.keys(),
      ...this.threadBrowsers.keys(),
    ]);
    await Promise.allSettled([...threadIds].map((threadId) => this.release(threadId)));
    await Promise.allSettled([...this.resourceBrowsers.values()].map((browser) => browser.close()));
    this.resourceBrowsers.clear();
    this.browserReferences.clear();
    this.browserDestroyRequests.clear();
    this.browserReconnects.clear();
  }
}
