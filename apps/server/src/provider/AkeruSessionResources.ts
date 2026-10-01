import * as Predicate from "effect/Predicate";
import { SharedBotBrowsers } from "./resources/SharedBotBrowsers.ts";
import type { ToolsInput } from "@mastra/core/agent";
import { createMcpManager, type McpManager } from "@mastra/code-sdk/mcp/index";
import type { Workspace } from "@mastra/core/workspace";
import { createBotBrowser } from "./botBrowser.ts";
import { createBotWorkspace, isRemoteBotSandbox } from "./botWorkspace.ts";
import { BotWorkspacePool, type BotWorkspaceLease } from "./botWorkspacePool.ts";
import { computerRegistry } from "./computerRegistry.ts";
import { mcpServerNeedsBrowserAttachment } from "./McpServerConfig.ts";
import {
  CODEX_COMPUTER_USE_SERVER_ID,
  isCodexComputerUseServer,
  isCodexComputerUseTool,
  resolveCodexComputerUseServer,
  sanitizeCodexComputerUseResult,
} from "./CodexComputerUse.ts";
import {
  type AkeruSessionResourcesOptions,
  type AkeruSessionResourceView,
  type BrowserAttribution,
  type AkeruSessionResourceInput,
} from "./resources/AkeruSessionResourceTypes.ts";

const AKERU_PREVIEW_MCP_SERVER_NAME = "akeru";

const AKERU_PREVIEW_TOOL_PREFIX = `${AKERU_PREVIEW_MCP_SERVER_NAME}_`;

/**
 * Mastra sessions reach image generation through the GenerateImage catalog
 * tool on the runtime, not the shared `/mcp` server (their credential never
 * carries the `image` capability). Hide the dead MCP copy so a bot sees
 * exactly one image tool.
 */
const AKERU_MASTRA_HIDDEN_TOOLS = new Set([`${AKERU_PREVIEW_TOOL_PREFIX}generate_image`]);

export class AkeruSessionResources {
  private readonly browsers: SharedBotBrowsers;
  private readonly options: AkeruSessionResourcesOptions;
  private readonly acquisitions = new Map<string, Promise<AkeruSessionResourceView>>();
  private readonly mcpManagers = new Map<string, McpManager>();
  private readonly workspaceLeases = new Map<string, BotWorkspaceLease>();
  private readonly userComputerWorkspaceLeases = new Map<string, BotWorkspaceLease>();
  private readonly workspacePool = new BotWorkspacePool();
  private readonly computerRegistrations = new Map<string, () => void>();
  private readonly computerUseTemporaryDirectories = new Map<string, string>();
  private readonly tenkiThreads = new Set<string>();
  private controllingThreadId: string | undefined;
  private shuttingDown = false;

  constructor(options: AkeruSessionResourcesOptions) {
    this.options = options;
    this.browsers = new SharedBotBrowsers(options);
  }

  acquire(input: AkeruSessionResourceInput): Promise<AkeruSessionResourceView> {
    if (this.shuttingDown) {
      return Promise.reject(new Error("Akeru session resources are shutting down."));
    }

    if (
      input.botSandbox === "railway" &&
      input.mcpServers.some((server) => mcpServerNeedsBrowserAttachment(server, true))
    ) {
      return Promise.reject(
        new Error(
          "Railway previews require a Railway CLI tunnel. Disable browser-dependent connectors before starting this bot; automatic browser routing is not supported.",
        ),
      );
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
            io: this.options.io,
            threadId: input.resourceScope,
            workspaceId: input.workspaceId,
            identityFile: this.options.io.path.join(
              this.options.stateDir,
              "bot-workspaces",
              input.workspaceId,
              "provider.json",
            ),
            ...(isRemoteBotSandbox(input.botSandbox)
              ? {
                  sandbox: input.botSandbox,
                  ...(input.sandboxEnvironment ? { environment: input.sandboxEnvironment } : {}),
                }
              : {
                  sandbox: "local" as const,
                  localRoot: this.options.io.path.join(
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
              io: this.options.io,
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

      const existingBrowser = this.browsers.resourceBrowsers.get(input.workspaceResourceKey);

      if (!existingBrowser) this.browsers.browserFailures.delete(input.workspaceResourceKey);

      if (input.botId) {
        const attributions =
          this.browsers.browserAttributions.get(input.workspaceResourceKey) ??
          new Map<string, BrowserAttribution>();

        const botKey = String(input.botId);
        const existingAttribution = attributions.get(botKey);
        attributions.set(
          botKey,
          existingAttribution
            ? { ...existingAttribution, references: existingAttribution.references + 1 }
            : {
                botId: input.botId,
                botName: input.botName ?? "Bot",
                taskOrRoutine: input.taskOrRoutine ?? "Browser task",
                references: 1,
              },
        );
        this.browsers.browserAttributions.set(input.workspaceResourceKey, attributions);
        this.browsers.browserThreadBots.set(key, String(input.botId));
        const activeFailure = this.browsers.browserFailures.get(input.workspaceResourceKey);

        if (!existingAttribution && activeFailure) {
          this.options.onBrowserFailure?.({
            ...attributions.get(botKey)!,
            resourceKey: input.workspaceResourceKey,
            detail: activeFailure,
          });
        }
      }

      let browser = existingBrowser;

      if (!browser) {
        browser = (this.options.makeBotBrowser ?? createBotBrowser)({
          threadId: input.resourceScope,
          workspace: workspaceLease.workspace.workspace,
          cacheDir: this.options.io.path.join(this.options.stateDir, "bot-browser-runtime"),
          ...(workspaceLease.workspace.computer
            ? { makeRpc: () => workspaceLease.workspace.computer! }
            : {}),
          ...(workspaceLease.workspace.browserEndpoint
            ? { browserEndpoint: workspaceLease.workspace.browserEndpoint }
            : {}),
          ...(this.options.onBrowserFailure
            ? {
                onFailure: (error) => {
                  if (this.browsers.resourceBrowsers.get(input.workspaceResourceKey) === browser) {
                    this.browsers.reportBrowserFailure(input.workspaceResourceKey, error);
                  }
                },
              }
            : {}),
          ...(this.options.onBrowserReady
            ? {
                onReady: () => {
                  if (this.browsers.resourceBrowsers.get(input.workspaceResourceKey) === browser) {
                    this.browsers.resolveBrowserFailures(input.workspaceResourceKey);
                  }
                },
              }
            : {}),
        });
      }

      if (workspaceLease.workspace.computer && input.exclusiveComputer) {
        this.computerRegistrations.set(
          key,
          computerRegistry.register(key, workspaceLease.workspace.computer, null),
        );
      }

      this.browsers.resourceBrowsers.set(input.workspaceResourceKey, browser);
      this.browsers.threadBrowsers.set(key, browser);
      this.browsers.browserResourceKeys.set(key, input.workspaceResourceKey);
      this.browsers.browserReferences.set(
        input.workspaceResourceKey,
        (this.browsers.browserReferences.get(input.workspaceResourceKey) ?? 0) + 1,
      );

      let reconnect = this.browsers.browserReconnects.get(input.workspaceResourceKey);

      if (existingBrowser && workspaceLease.wokeFromSleep && !reconnect) {
        reconnect = browser.reconnect().finally(() => {
          this.browsers.browserReconnects.delete(input.workspaceResourceKey);
        });
        this.browsers.browserReconnects.set(input.workspaceResourceKey, reconnect);
      }

      try {
        await reconnect;
      } catch (cause) {
        await this.browsers.invalidateBrowser(input.workspaceResourceKey, browser);
        throw cause;
      }

      const previewMcpServerConfig = this.options.getPreviewMcpServerConfig?.(key);

      if (input.mcpServers.length > 0 || previewMcpServerConfig) {
        const attachment =
          input.botSandbox !== "tenki" &&
          input.mcpServers.some((server) => mcpServerNeedsBrowserAttachment(server, remote))
            ? await browser.attachment()
            : undefined;

        const configs = this.options.toMcpServerConfigs(input.mcpServers, attachment);

        if (previewMcpServerConfig) {
          configs[AKERU_PREVIEW_MCP_SERVER_NAME] = previewMcpServerConfig;
        }

        if (usesComputer) {
          if (!this.options.hostPlatform) {
            throw new Error("Computer Use host platform is unavailable.");
          }

          const config = await (
            this.options.resolveComputerUseServer ?? resolveCodexComputerUseServer
          )({ platform: this.options.hostPlatform });

          configs[CODEX_COMPUTER_USE_SERVER_ID] = config;
          const temporaryDirectory = config.env?.TMPDIR;

          if (Predicate.isString(temporaryDirectory)) {
            this.computerUseTemporaryDirectories.set(key, temporaryDirectory);
          }
        }

        const manager = (this.options.makeMcpManager ?? createMcpManager)(
          this.options.io.path.join(this.options.stateDir, "bot-mcp-runtime"),
          ".akeru-runtime",
          configs,
        );

        this.mcpManagers.set(key, manager);

        let computerUseFailed = false;

        try {
          await manager.init();
        } catch (cause) {
          for (const server of input.mcpServers) {
            this.options.onMcpServerConnectionFailure?.(server.id);
          }

          // Computer Use MCP errors can name private desktop paths, so they are replaced below
          // rather than wrapped.
          if (!usesComputer) throw cause;
          computerUseFailed = true;
        }

        if (computerUseFailed) throw new Error("Computer Use MCP failed to start.");

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

      if (input.botSandbox === "tenki") this.tenkiThreads.add(key);

      return {
        workspace:
          userComputerWorkspaceLease?.workspace.workspace ?? workspaceLease.workspace.workspace,
        botWorkspace: workspaceLease.workspace.workspace,
      };
    } catch (cause) {
      await this.releaseOnce(key, {
        destroy:
          input.botSandbox !== "railway" &&
          input.botSandbox !== "tenki" &&
          input.botSandbox !== "ascii",
      }).catch(() => undefined);
      throw cause;
    }
  }

  getConnectorTools(threadId: string): ToolsInput {
    const browserTools = this.browsers.threadBrowsers.get(threadId)?.tools;

    const tools: ToolsInput = {
      ...(!this.tenkiThreads.has(threadId) ? browserTools : undefined),
      ...this.mcpManagers.get(threadId)?.getTools(),
    };

    return Object.fromEntries(
      Object.entries(tools)
        .filter(([name]) => !AKERU_MASTRA_HIDDEN_TOOLS.has(name))
        .map(([name, tool]) => {
          const exposedName = name.startsWith(AKERU_PREVIEW_TOOL_PREFIX)
            ? name.slice(AKERU_PREVIEW_TOOL_PREFIX.length)
            : name;

          const execute = "execute" in tool ? tool.execute : undefined;

          if (!isCodexComputerUseTool(name) || !Predicate.isFunction(execute)) {
            return [exposedName, tool];
          }

          return [
            exposedName,
            {
              ...tool,
              execute: async (...args: readonly unknown[]) => {
                const temporaryDirectory = this.computerUseTemporaryDirectories.get(threadId);

                return sanitizeCodexComputerUseResult(
                  await execute.call(tool, ...args),
                  temporaryDirectory ? { temporaryDirectory } : undefined,
                );
              },
            },
          ];
        }),
    );
  }

  getMcpManager(threadId: string): McpManager | undefined {
    return this.mcpManagers.get(threadId);
  }

  getMcpManagersForServer(serverId: string): readonly McpManager[] {
    return this.getMcpManagerSessionsForServer(serverId).map(({ manager }) => manager);
  }

  getMcpManagerSessionsForServer(
    serverId: string,
  ): readonly { readonly threadId: string; readonly manager: McpManager }[] {
    return [...this.mcpManagers.entries()].flatMap(([threadId, manager]) =>
      Object.hasOwn(manager.getConfig().mcpServers ?? {}, serverId) ? [{ threadId, manager }] : [],
    );
  }

  getWorkspace(threadId: string): Workspace | undefined {
    return (
      this.userComputerWorkspaceLeases.get(threadId)?.workspace.workspace ??
      this.workspaceLeases.get(threadId)?.workspace.workspace
    );
  }

  retryFailedWorkspaceSleeps(): Promise<void> {
    return this.workspacePool.retryFailedSleeps();
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
    this.tenkiThreads.delete(threadId);

    if (manager) await manager.disconnect().catch((cause) => failures.push(cause));
    const computerUseTemporaryDirectory = this.computerUseTemporaryDirectories.get(threadId);
    this.computerUseTemporaryDirectories.delete(threadId);

    if (computerUseTemporaryDirectory) {
      try {
        await this.options.io.remove(computerUseTemporaryDirectory, true);
      } catch (cause) {
        failures.push(cause);
      }
    }

    this.computerRegistrations.get(threadId)?.();
    this.computerRegistrations.delete(threadId);
    const browser = this.browsers.threadBrowsers.get(threadId);
    const resourceKey = this.browsers.browserResourceKeys.get(threadId);
    this.browsers.threadBrowsers.delete(threadId);
    this.browsers.browserResourceKeys.delete(threadId);

    if (browser && resourceKey) {
      const botKey = this.browsers.browserThreadBots.get(threadId);
      this.browsers.browserThreadBots.delete(threadId);

      if (botKey) {
        const attribution = this.browsers.browserAttributions.get(resourceKey)?.get(botKey);

        if (attribution && attribution.references > 1) attribution.references -= 1;
        else this.browsers.browserAttributions.get(resourceKey)?.delete(botKey);
      }

      if (options?.destroy) this.browsers.browserDestroyRequests.add(resourceKey);
      const references = Math.max(0, (this.browsers.browserReferences.get(resourceKey) ?? 1) - 1);

      if (references > 0) {
        this.browsers.browserReferences.set(resourceKey, references);
      } else {
        this.browsers.browserReferences.delete(resourceKey);

        if (
          this.browsers.browserDestroyRequests.delete(resourceKey) &&
          this.browsers.resourceBrowsers.get(resourceKey) === browser
        ) {
          this.browsers.resourceBrowsers.delete(resourceKey);
          await browser.close().catch((cause) => failures.push(cause));
        }
      }
    }

    const workspaceLease = this.workspaceLeases.get(threadId);
    this.workspaceLeases.delete(threadId);

    if (workspaceLease) {
      await workspaceLease.release(options).catch(async (cause) => {
        failures.push(cause);

        if (browser && resourceKey) await this.browsers.invalidateBrowser(resourceKey, browser);
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

  async shutdown(): Promise<void> {
    const failures: unknown[] = [];
    this.shuttingDown = true;
    await Promise.allSettled(this.acquisitions.values());

    const threadIds = new Set([
      ...this.acquisitions.keys(),
      ...this.workspaceLeases.keys(),
      ...this.userComputerWorkspaceLeases.keys(),
      ...this.mcpManagers.keys(),
      ...this.browsers.threadBrowsers.keys(),
    ]);

    const releases = await Promise.allSettled(
      [...threadIds].map((threadId) => this.release(threadId)),
    );

    for (const result of releases) {
      if (result.status === "rejected") failures.push(result.reason);
    }

    try {
      await this.workspacePool.retryFailedSleeps();
    } catch (cause) {
      failures.push(cause);
    }

    const browserClosures = await Promise.allSettled(
      [...this.browsers.resourceBrowsers.values()].map((browser) => browser.close()),
    );

    for (const result of browserClosures) {
      if (result.status === "rejected") failures.push(result.reason);
    }

    this.browsers.resourceBrowsers.clear();
    this.browsers.browserReferences.clear();
    this.browsers.browserDestroyRequests.clear();
    this.browsers.browserReconnects.clear();
    this.browsers.browserAttributions.clear();
    this.browsers.browserFailures.clear();
    this.browsers.browserThreadBots.clear();

    if (failures.length > 0) throw failures[0];
  }
}

export {
  type AkeruSessionResourceInput,
  type AkeruSessionResourceView,
  type AkeruSessionResourcesOptions,
} from "./resources/AkeruSessionResourceTypes.ts";
