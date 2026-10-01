// @effect-diagnostics globalFetch:off nodeBuiltinImport:off
import type { McpManager } from "@mastra/code-sdk/mcp/index";
import {
  type BotId,
  type ComposioToolkit,
  type OrchestrationCommand,
  type OrchestrationReadModel,
} from "@akeru/contracts";
import type { RequestHealthStatus } from "../../subscription-auth/service.ts";

export interface AkeruCatalogToolHandlerInput {
  readonly input: unknown;
  readonly emitProgress: (
    summary: string,
    details?: { readonly authorizationUrl?: string },
  ) => void | Promise<void>;
}

export type AkeruCatalogToolHandler = (input: AkeruCatalogToolHandlerInput) => Promise<unknown>;

export interface AkeruMcpDependencies {
  readonly dependentBots: ReadonlyArray<{ readonly id: BotId; readonly name: string }>;
  readonly dependentRoutines: ReadonlyArray<string>;
}

export interface AkeruMcpHealthHandlerOptions {
  readonly getRequestHealth: (serverId: string) => RequestHealthStatus | undefined;
  readonly recordSuccess: (serverId: string, at: string) => void;
  readonly recordFailure: (serverId: string, message: string, at: string) => void;
  readonly getDependencies: (serverId: string) => Promise<AkeruMcpDependencies>;
  readonly onFailure?: (
    serverId: string,
    message: string,
    dependencies: AkeruMcpDependencies,
  ) => void | Promise<void>;
  readonly onRecovery?: (
    serverId: string,
    dependencies: AkeruMcpDependencies,
  ) => void | Promise<void>;
  readonly authenticationExpiresAt?: (serverId: string) => string | undefined;
  readonly now?: () => string;
}

export type McpRuntimeStatus = ReturnType<McpManager["getServerStatuses"]>[number];

export interface AkeruPluginRuntimeOptions {
  readonly readSnapshot: () => Promise<OrchestrationReadModel>;
  readonly dispatch: (command: OrchestrationCommand) => Promise<unknown>;
  readonly searchComposioToolkits?: (input: {
    readonly query?: string;
    readonly limit?: number;
  }) => Promise<{
    readonly status: "available" | "setup-required" | "unavailable";
    readonly toolkits: readonly ComposioToolkit[];
  }>;
  readonly now?: () => string;
  readonly id?: () => string;
}

export interface AkeruCatalogBackendOptions {
  readonly webSearch?: (input: {
    readonly query: string;
    readonly domains?: readonly string[];
  }) => Promise<unknown>;
  readonly webFetch?: (input: { readonly url: string }) => Promise<unknown>;
  readonly generateImage?: (input: unknown) => Promise<unknown>;
  readonly addMcpServer?: (input: unknown) => Promise<unknown>;
  readonly uninstallMcpServer?: (serverId: string) => Promise<unknown>;
  readonly removeMcpAccount?: (serverId: string) => Promise<unknown>;
  readonly renameMcpAccount?: (input: unknown) => Promise<unknown>;
  readonly setMcpInstructions?: (input: {
    readonly serverId: string;
    readonly instructions: string;
  }) => Promise<unknown>;
}
