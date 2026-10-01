import { createMcpManager } from "@mastra/code-sdk/mcp/index";

import { Workspace } from "@mastra/core/workspace";
import { ThreadId } from "@akeru/contracts";

import * as Effect from "effect/Effect";

import type * as Scope from "effect/Scope";

import { BotMemoryStore } from "../../../memory/BotMemory.ts";

import { type EntityMemoryRepositoryShape } from "../../../memory/Services/EntityMemoryRepository.ts";

import * as McpSessionRegistry from "../../../mcp/McpSessionRegistry.ts";

import {
  type AkeruMastraHarness,
  type AkeruMastraHarnessError,
  type AkeruMastraHarnessOptions,
} from "../../AkeruMastraHarness.ts";

import { type AkeruDelegationRuntime } from "../../AkeruDelegationRuntime.ts";

import { type AkeruWebFetchOptions } from "../../AkeruWebFetch.ts";

import type { BotBrowser, CreateBotBrowserInput } from "../../botBrowser.ts";

import { resolveCodexComputerUseServer } from "../../CodexComputerUse.ts";
import { type AkeruBotWorkspace, type CreateRemoteBotWorkspaceInput } from "../../botWorkspace.ts";

export interface AgentControllerLiveOptions {
  /** Builds the harness in the layer scope; closing the scope shuts it down. */
  readonly makeMastraHarness?: (
    options: AkeruMastraHarnessOptions,
  ) => Effect.Effect<AkeruMastraHarness, AkeruMastraHarnessError, Scope.Scope>;
  readonly makeMcpManager?: typeof createMcpManager;
  readonly makeRemoteWorkspace?: (
    input: CreateRemoteBotWorkspaceInput,
  ) => Promise<AkeruBotWorkspace | Workspace>;
  readonly makeBotBrowser?: (input: CreateBotBrowserInput) => BotBrowser;
  readonly resolveComputerUseServer?: typeof resolveCodexComputerUseServer;
  readonly issueMcpCredential?: typeof McpSessionRegistry.issueActiveMcpCredential;
  readonly revokeMcpCredential?: typeof McpSessionRegistry.revokeActiveMcpThread;
  readonly entityMemoryRepository?: EntityMemoryRepositoryShape;
  readonly botMemoryStore?: BotMemoryStore;
  readonly delegationRuntime?: Pick<
    AkeruDelegationRuntime,
    "send" | "sendToUser" | "parentFinished" | "accessForThread"
  > &
    Partial<Pick<AkeruDelegationRuntime, "create" | "check" | "stop" | "dispatchDelegation">>;
  readonly readAttachment?: (path: string) => Promise<Uint8Array>;
  /** Overrides the WebFetch resolver and address policy in tests. */
  readonly webFetch?: AkeruWebFetchOptions;
  /**
   * Overrides the image generation entry for tests. Defaults to
   * `runImageGenerationTool`, which calls the active ImageGenerationRuntime.
   */
  readonly generateImage?: (threadId: ThreadId, input: unknown) => Effect.Effect<unknown>;
}
