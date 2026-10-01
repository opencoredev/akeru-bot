import { createMcpManager, type McpServerConfig } from "@mastra/code-sdk/mcp/index";
import type { Workspace } from "@mastra/core/workspace";
import type { BotId, BotSandbox, McpServer } from "@akeru/contracts";
import {
  type BotBrowser,
  type BotBrowserAttachment,
  type CreateBotBrowserInput,
} from "../browser/BotBrowserTypes.ts";
import {
  type AkeruBotWorkspace,
  type CreateRemoteBotWorkspaceInput,
} from "../workspace/BotWorkspaceTypes.ts";
import { resolveCodexComputerUseServer } from "../CodexComputerUse.ts";

export interface AkeruSessionResourceInput {
  readonly threadId: string;
  readonly resourceScope: string;
  readonly workspaceResourceKey: string;
  readonly workspaceId: string;
  readonly botSandbox?: BotSandbox | null;
  readonly sandboxEnvironment?: Readonly<Record<string, string>>;
  readonly userComputerCwd?: string;
  readonly mcpServers: readonly McpServer[];
  readonly exclusiveComputer?: boolean;
  readonly botId?: BotId;
  readonly botName?: string;
  readonly taskOrRoutine?: string;
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
  readonly onBrowserFailure?: (input: {
    readonly botId: BotId;
    readonly botName: string;
    readonly taskOrRoutine: string;
    readonly detail: string;
    readonly resourceKey: string;
  }) => void;
  readonly onBrowserReady?: (botId: BotId, resourceKey: string) => void;
  readonly getPreviewMcpServerConfig?: (threadId: string) => McpServerConfig | undefined;
  readonly toMcpServerConfigs: (
    servers: readonly McpServer[],
    browser?: BotBrowserAttachment,
  ) => Record<string, McpServerConfig>;
}

export interface BrowserAttribution {
  readonly botId: BotId;
  readonly botName: string;
  readonly taskOrRoutine: string;
  references: number;
}
