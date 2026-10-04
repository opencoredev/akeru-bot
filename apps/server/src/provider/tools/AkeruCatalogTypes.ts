import type { AkeruToolResult } from "./AkeruToolTypes.ts";
import { type AkeruToolInputSchemas } from "@akeru/contracts";
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

export type AkeruCatalogToolHandler = (
  input: AkeruCatalogToolHandlerInput,
) => Promise<AkeruToolResult>;

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
  readonly dispatch: (
    command: OrchestrationCommand,
  ) => Promise<{ readonly sequence: number } | void>;
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
  }) => Promise<AkeruToolResult>;
  readonly webFetch?: (input: { readonly url: string }) => Promise<AkeruToolResult>;
  readonly generateImage?: (
    input: (typeof AkeruToolInputSchemas.GenerateImage)["Type"],
  ) => Promise<AkeruToolResult>;
  readonly addMcpServer?: (
    input: (typeof AkeruToolInputSchemas.AddMcpServer)["Type"],
  ) => Promise<AkeruToolResult>;
  readonly uninstallMcpServer?: (serverId: string) => Promise<AkeruToolResult>;
  readonly removeMcpAccount?: (serverId: string) => Promise<AkeruToolResult>;
  readonly renameMcpAccount?: (
    input: (typeof AkeruToolInputSchemas.RenameMcpAccount)["Type"],
  ) => Promise<AkeruToolResult>;
  readonly setMcpInstructions?: (input: {
    readonly serverId: string;
    readonly instructions: string;
  }) => Promise<AkeruToolResult>;
}
