// @effect-diagnostics globalDate:off globalConsole:off globalRandom:off nodeBuiltinImport:off globalTimers:off globalFetch:off
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { AuthStorage } from "@mastra/code-sdk/auth/storage";
import {
  createMcpManager,
  type McpManager,
  type McpServerConfig,
} from "@mastra/code-sdk/mcp/index";
import { TOOL_NAME_OVERRIDES } from "@mastra/code-sdk/tool-names";
import type {
  AgentControllerEvent,
  MastraDBMessage,
  MastraMessagePart,
} from "@mastra/core/agent-controller";
import { Workspace } from "@mastra/core/workspace";
import {
  AkeruUsageReservationId,
  CommandId,
  EventId,
  MessageId,
  ProviderDriverKind,
  ProviderInstanceId,
  McpServerId,
  RuntimeItemId,
  RuntimeRequestId,
  RoutineId,
  TurnId,
  AKERU_TOOL_CATALOG,
  BALANCED_BOT_PERSONALITY_TONE,
  DEFAULT_BOT_SANDBOX_BROWSER_SHARING,
  type BotId,
  type BotPersonalityTone,
  type McpServer,
  type AkeruCreateRoutineInput,
  type ModelSelection,
  type ProviderApprovalDecision,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type RuntimeMode,
  ThreadId,
  AKERU_PRODUCT_FEEDBACK_TOOL_NAME,
  type AkeruDelegationAccessGrant,
  type AkeruDelegationRecord,
  type AkeruMemoryDocumentTarget,
  type AkeruMemoryThreadAccess,
  type OrchestrationCommand,
  type OrchestrationReadModel,
  AKERU_CREATE_ROUTINE_TOOL_NAME,
  decodeAkeruToolInput,
} from "@akeru/contracts";
import { driverSupportsDelegation } from "@akeru/shared/delegationProviders";
import { HostProcessPlatform } from "@akeru/shared/hostProcess";
import { getModelSelectionStringOptionValue } from "@akeru/shared/model";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { getCodexServiceTierOptionValue } from "../../codexModelOptions.ts";
import { BotInboxService } from "../../bot-inbox/service.ts";
import { recordBrowserFailure, resolveBrowserFailure } from "../../bot-inbox/browserIncidents.ts";
import { recordUserActionIncident } from "../../bot-inbox/userActionIncidents.ts";
import { ServerConfig } from "../../config.ts";
import {
  BotMemoryStore,
  formatBotMemoryPrompt,
  type BotMemoryAccess,
} from "../../memory/BotMemory.ts";
import {
  createBotMemoryToolHandler,
  type AkeruMemoryShareFact,
  type AkeruMemoryToolHandler,
} from "../../memory/BotMemoryToolHandlers.ts";
import {
  legacyMemoryMigrationKeys,
  legacyMemoryMigrationAccesses,
  migrateLegacyBotMemory,
} from "../../memory/LegacyMemoryMigration.ts";
import {
  EntityMemoryRepository,
  type EntityMemoryRepositoryShape,
} from "../../memory/Services/EntityMemoryRepository.ts";
import { buildProviderMemoryPacket } from "../../memory/ProviderMemoryPacket.ts";
import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { retainProjectionMessagesAfterRevert } from "../../orchestration/RetainedRevertMessages.ts";
import { ProjectionThreadMessageRepository } from "../../persistence/Services/ProjectionThreadMessages.ts";
import { ProjectionTurnRepository } from "../../persistence/Services/ProjectionTurns.ts";
import { ProjectionThreadMessageRepositoryLive } from "../../persistence/Layers/ProjectionThreadMessages.ts";
import { ProjectionTurnRepositoryLive } from "../../persistence/Layers/ProjectionTurns.ts";
import * as McpProviderSession from "../../mcp/McpProviderSession.ts";
import * as McpMemoryToolSession from "../../mcp/McpMemoryToolSession.ts";
import * as McpInvocationContext from "../../mcp/McpInvocationContext.ts";
import * as McpSessionRegistry from "../../mcp/McpSessionRegistry.ts";
import * as ServerSettings from "../../serverSettings.ts";
import { AKERU_TURN_USAGE_RESERVATION_TOKENS, BotUsageLedger } from "../../usage/BotUsageLedger.ts";
import { persistAkeruPreviewSnapshot } from "../AkeruPreviewSnapshotAttachment.ts";
import {
  SubscriptionAuthService,
  type SubscriptionProviderId,
} from "../../subscription-auth/service.ts";
import {
  akeruActionNeedsApproval,
  akeruToolCategory,
  makeAkeruMastraHarness,
  criticalAkeruAction,
  mastraModelId,
  openCodeGoInlineConnection,
  type AkeruMastraHarness,
  type AkeruMastraHarnessError,
  type AkeruMastraHarnessOptions,
  type AkeruMastraSession,
} from "../AkeruMastraHarness.ts";
import { createAkeruBotTurnInstructions } from "../AkeruAgentInstructions.ts";
import type { ProviderInstanceRoutingInfo } from "../Services/ProviderAdapterRegistry.ts";
import { createAkeruChannelRuntime, type AkeruChannelRuntime } from "../AkeruChannelRuntime.ts";
import { createAkeruBotStateRuntime, type AkeruBotStateRuntime } from "../AkeruBotStateRuntime.ts";
import { AkeruMemoryTurnHarness, type AkeruMemoryTurn } from "../AkeruMemoryTurnHarness.ts";
import {
  createAkeruDelegationRuntime,
  type AkeruDelegationChildOutcome,
  type AkeruDelegationRuntime,
  type AkeruDelegationRuntimeOptions,
} from "../AkeruDelegationRuntime.ts";
import {
  AkeruWorkerError,
  isWorkerThreadId,
  makeAkeruWorkerRuntime,
  WORKER_THREAD_ID_PREFIX,
  workerAccess,
} from "../AkeruWorkerRuntime.ts";
import { makeAkeruRuntimeSeam } from "../AkeruRuntimeSeam.ts";
import {
  AKERU_CHILD_WAIT_DEFAULT_TIMEOUT,
  AKERU_ROUTINE_REVIEW_TIMEOUT,
  makePendingWaiters,
} from "../PendingWaiters.ts";
import {
  createAkeruCatalogToolHandlers,
  createAkeruPluginRuntime,
  type AkeruPluginRuntimeOptions,
} from "../AkeruCatalogToolHandlers.ts";
import {
  akeruWebSearchUnavailable,
  createAkeruWebFetch,
  type AkeruWebFetchOptions,
} from "../AkeruWebFetch.ts";
import {
  cancelActiveImageGenerations,
  runImageGenerationTool,
} from "../../image-generation/ImageGenerationRuntime.ts";
import {
  formatMcpServerInstructions,
  getMcpRuntimeHeaders,
  mcpServerNeedsBrowserAttachment,
  sameMcpServerConfigurations,
} from "../McpServerConfig.ts";
import {
  createAkeruToolRuntime,
  isMemoryToolId,
  type AkeruToolSession,
} from "../AkeruToolRuntime.ts";
import type { BotBrowser, BotBrowserAttachment, CreateBotBrowserInput } from "../botBrowser.ts";
import { AkeruSessionResources } from "../AkeruSessionResources.ts";
import { authenticateMcpServer } from "../McpServerAuthentication.ts";
import {
  isCodexComputerUseServer,
  isCodexComputerUseTool,
  resolveCodexComputerUseServer,
} from "../CodexComputerUse.ts";
import {
  isRemoteBotSandbox,
  type AkeruBotWorkspace,
  type CreateRemoteBotWorkspaceInput,
} from "../botWorkspace.ts";
import {
  botRuntimeResourceScope,
  botWorkspaceCredentialFingerprint,
  botWorkspaceIdentity,
  botWorkspaceResourceKey,
} from "../botWorkspacePool.ts";
import {
  AgentControllerRuntimeError,
  AgentControllerUnsupportedEngineError,
  ProviderValidationError,
} from "../Errors.ts";
import {
  AgentController,
  type AgentControllerSendTurnInput,
  type AgentControllerShape,
} from "../Services/AgentController.ts";
import { LegacyProviderBridge } from "../Services/LegacyProviderBridge.ts";
import { RoutineDraftDispatcher } from "../../routines/RoutineDraftDispatcher.ts";
import { MemoryApprovals } from "../../memory/MemoryApprovals.ts";

const DEFAULT_MODE_ID = "build";
const DEFAULT_MEMORY_TOOL_SETTINGS = {
  enabled: true,
  privateBotMemory: true,
  sharedProjectMemory: "ask",
} as const;
const PLAN_MODE_ID = "plan";
const BUILTIN_MASTRA_TOOL_NAMES: ReadonlySet<string> = new Set(
  Object.values(TOOL_NAME_OVERRIDES).map((tool) => tool.name),
);
const APPROVAL_FREE_MASTRA_TOOL_NAMES: ReadonlySet<string> = new Set(["ask_user"]);
type MastraSession = AkeruMastraSession;

function omitNullToolFields(input: unknown): unknown {
  if (!input || typeof input !== "object" || Array.isArray(input)) return input;
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== null));
}

interface ResolvedEngine {
  readonly modelSelection: ModelSelection;
  readonly provider: ProviderDriverKind;
  readonly providerInstanceId: ProviderInstanceId;
  readonly mastraModelId: string;
  readonly mode: "default" | "plan";
  readonly botConversation: boolean;
  readonly botName?: string;
  readonly personalityTone?: BotPersonalityTone;
}

function mastraModelOptions(resolved: ResolvedEngine) {
  if (resolved.provider !== "codex") return undefined;
  const reasoningEffort = getModelSelectionStringOptionValue(
    resolved.modelSelection,
    "reasoningEffort",
  );
  const serviceTier = getCodexServiceTierOptionValue(resolved.modelSelection);
  return {
    ...(reasoningEffort ? { reasoningEffort } : {}),
    ...(serviceTier ? { serviceTier } : {}),
  };
}

interface ActiveAssistantMessage {
  readonly messageId: string;
  text: string;
  publishedText: string;
  revision: number;
}

interface ActiveTurn {
  readonly turnId: TurnId;
  readonly assistantMessages: Map<string, ActiveAssistantMessage>;
  waiting: boolean;
  /** Suspended tool calls still waiting for a user answer. */
  readonly suspendedToolCalls: Set<string>;
  finished: boolean;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  memoryQueued: boolean;
  assistantText: string;
}

interface PendingTurn {
  readonly threadId: ThreadId;
  readonly turnId: TurnId;
  readonly message: Parameters<MastraSession["sendMessage"]>[0];
  readonly botUsage: AgentControllerSendTurnInput["botUsage"];
  readonly toolSession: AkeruToolSession;
  readonly memoryAccess: BotMemoryAccess | undefined;
  readonly entityMemoryAccess: AkeruMemoryThreadAccess | undefined;
  readonly reviewInput: string;
  readonly hiddenWake: boolean;
  readonly delegationResults: string | undefined;
}

interface ActiveSession {
  startInput: Parameters<AgentControllerShape["startSession"]>[1];
  readonly session: MastraSession;
  readonly provider: ProviderDriverKind;
  readonly providerInstanceId: ProviderInstanceId;
  cwd: string | undefined;
  readonly createdAt: string;
  readonly mcpServerIds: readonly McpServer["id"][];
  readonly mcpServers: readonly McpServer[];
  runtimeMode: RuntimeMode;
  model: string;
  status: ProviderSession["status"];
  turnAdmissionGeneration: number;
  activeTurn: ActiveTurn | null;
  admittingTurn: PendingTurn | null;
  readonly pendingTurns: PendingTurn[];
  readonly pendingDispatches: Set<Promise<void>>;
  readonly toolNames: Map<string, string>;
  readonly approvalRequests: Map<string, { readonly name: string; readonly input: unknown }>;
  readonly connectorSessionApprovals: Set<string>;
  toolSession: AkeruToolSession;
  memoryAccess: BotMemoryAccess | undefined;
  entityMemoryAccess: AkeruMemoryThreadAccess | undefined;
  configuredToolSession: AkeruToolSession;
  configuredMemoryAccess: BotMemoryAccess | undefined;
  configuredEntityMemoryAccess: AkeruMemoryThreadAccess | undefined;
  privateBotMemory: boolean;
  readonly workspaceResourceKey: string;
  readonly pendingApprovals: Map<string, PendingApproval>;
  readonly unsubscribe: () => void;
}

interface PendingApproval {
  readonly toolName: string;
  readonly action: string;
}

interface LegacyTurnMemoryState {
  readonly observationPromptId: string;
  observationRecorded: boolean;
  readonly seenEventIds: Set<string>;
  readonly user: string;
  readonly modelId: string;
  turnId: string | undefined;
  dispatchReturned: boolean;
  readonly earlyEvents: Array<ProviderRuntimeEvent>;
  assistant: string;
  readonly memoryTurn: AkeruMemoryTurn | undefined;
  readonly hiddenWake: boolean;
  priorMemoryHandler?: AkeruMemoryToolHandler;
  reviewMemoryHandler?: AkeruMemoryToolHandler;
}

interface LegacyResourceIdentity {
  readonly workspaceResourceKey: string;
  readonly cwd: string | undefined;
  readonly provider: ProviderDriverKind;
  readonly providerInstanceId: ProviderInstanceId;
  memoryAccess: BotMemoryAccess | undefined;
  entityMemoryAccess: AkeruMemoryThreadAccess | undefined;
  readonly botName: string | undefined;
  readonly personalityTone: BotPersonalityTone;
  readonly memoryAccessKey: string | undefined;
  privateBotMemory: boolean;
}

/** Orchestration access for temporary workers and delegation. */
interface WorkerOrchestration {
  readonly readSnapshot: () => Promise<OrchestrationReadModel>;
  readonly dispatch: (command: OrchestrationCommand) => Promise<unknown>;
}

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

export function createAkeruMastraAuthStorage(secretsDir: string): AuthStorage {
  return new AuthStorage(NodePath.join(secretsDir, "subscription-auth.json"));
}

const MISSING_SUSPENDED_RUN = "AGENT_SEND_STREAM_RESUME_NO_SUSPENDED_THREAD_RUN";
const RESUME_FAILED_MESSAGE = "This response could not resume. Send your reply again.";

function isMissingSuspendedRun(detail: string): boolean {
  return (
    detail.includes(MISSING_SUSPENDED_RUN) || detail.includes("could not find a suspended run")
  );
}

function failureDetail(cause: unknown): string {
  const detail = cause instanceof Error ? cause.message : String(cause);
  return isMissingSuspendedRun(detail) ? RESUME_FAILED_MESSAGE : detail;
}

function sessionFailureDetail(active: Pick<ActiveSession, "mcpServerIds">, cause: unknown): string {
  return active.mcpServerIds.some((id) => isCodexComputerUseServer(String(id)))
    ? "Computer Use session failed."
    : failureDetail(cause);
}

function nowIso(): string {
  return new Date().toISOString();
}

/** Active bots that lose an MCP server when it goes away: every one that has not turned it off. */
function mcpServerDependentBots(snapshot: OrchestrationReadModel, serverId: string) {
  return snapshot.bots
    .filter(
      (bot) =>
        bot.archivedAt === null && !bot.disabledMcpServerIds.some((id) => String(id) === serverId),
    )
    .map((bot) => ({ id: bot.id, name: bot.name }));
}

/**
 * Deletes an MCP server for the Uninstall and Remove catalog tools. The result names the bots that
 * lose access, and the id is swept from every bot's disabled list so no dead id is left behind.
 */
async function deleteCatalogMcpServer(
  runtime: Pick<AkeruPluginRuntimeOptions, "readSnapshot" | "dispatch">,
  serverId: string,
  commandPrefix: "mcp-delete" | "mcp-remove",
) {
  const snapshot = await runtime.readSnapshot();
  const dependentBots = mcpServerDependentBots(snapshot, serverId);
  await runtime.dispatch({
    type: "mcp-server.delete",
    commandId: CommandId.make(`catalog:${commandPrefix}:${NodeCrypto.randomUUID()}`),
    mcpServerId: McpServerId.make(serverId),
  });
  const sweptBots = snapshot.bots.filter((bot) =>
    bot.disabledMcpServerIds.some((id) => String(id) === serverId),
  );
  for (const swept of sweptBots) {
    // Each bot's list is re-read so a setting saved since the first snapshot
    // survives the sweep.
    const bot = (await runtime.readSnapshot()).bots.find((entry) => entry.id === swept.id);
    if (!bot?.disabledMcpServerIds.some((id) => String(id) === serverId)) continue;
    await runtime.dispatch({
      type: "bot.update",
      commandId: CommandId.make(`catalog:mcp-sweep:${NodeCrypto.randomUUID()}`),
      botId: bot.id,
      disabledMcpServerIds: bot.disabledMcpServerIds.filter((id) => String(id) !== serverId),
    });
  }
  return {
    serverId,
    removed: true,
    dependentBots,
    clearedDisabledFor: sweptBots.map((bot) => ({ id: bot.id, name: bot.name })),
  };
}

function eventId(): EventId {
  return EventId.make(`mastra-${NodeCrypto.randomUUID()}`);
}

type DelegatedUsage = Parameters<NonNullable<AkeruDelegationRuntimeOptions["recordUsage"]>>[0];

export function delegatedUsageReceipt(
  usage: DelegatedUsage,
  active: {
    readonly provider: ProviderDriverKind;
    readonly providerInstanceId: ProviderInstanceId;
  },
  createdAt = nowIso(),
): Extract<ProviderRuntimeEvent, { readonly type: "tool.receipt" }> {
  return {
    eventId: eventId(),
    provider: active.provider,
    providerInstanceId: active.providerInstanceId,
    threadId: usage.threadId,
    ...(usage.turnId ? { turnId: usage.turnId } : {}),
    createdAt,
    type: "tool.receipt",
    payload: {
      receiptId: `delegation:usage:${NodeCrypto.randomUUID()}`,
      toolId: "SendToAgent",
      phase: "success",
      threadId: usage.threadId,
      botId: usage.botId,
      billedBotId: usage.botId,
      fatalToThread: false,
      usage: { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens },
      createdAt,
    },
  };
}

function messageText(message: MastraDBMessage): string {
  return message.content.parts
    .filter(
      (part): part is MastraMessagePart & { text: string } =>
        part.type === "text" && typeof part.text === "string",
    )
    .map((part) => part.text)
    .join("");
}

function mastraModeId(mode: "default" | "plan"): string {
  return mode === "plan" ? PLAN_MODE_ID : DEFAULT_MODE_ID;
}

export function toMcpServerConfigs(
  servers: readonly McpServer[],
  browser?: BotBrowserAttachment,
): Record<string, McpServerConfig> {
  return Object.fromEntries(
    servers.map((server) => [String(server.id), toMcpServerConfig(server, browser)]),
  );
}

/**
 * Projects one persisted Akeru MCP registration into the Mastra connection
 * recipe. Authentication headers are transient runtime state and therefore
 * never become part of the persisted contract record.
 */
export function toMcpServerConfig(
  server: McpServer,
  browser?: BotBrowserAttachment,
): McpServerConfig {
  const runtimeHeaders = getMcpRuntimeHeaders(server);
  if (server.transport === "stdio") {
    const browserAttachment =
      browser && mcpServerNeedsBrowserAttachment(server, browser.availableToHostedPlugins)
        ? {
            AKERU_BROWSER_MCP_URL: browser.browserUrl,
            AKERU_BROWSER_MCP_SESSION_ID: browser.mcpSessionId,
            AKERU_BROWSER_MCP_HEADERS: JSON.stringify(browser.localRequestHeaders),
          }
        : undefined;
    return {
      command: server.command,
      ...(server.args ? { args: [...server.args] } : {}),
      ...(browserAttachment ? { env: browserAttachment } : {}),
    };
  }

  const browserHeaders =
    browser?.availableToHostedPlugins &&
    mcpServerNeedsBrowserAttachment(server, browser.availableToHostedPlugins)
      ? {
          ...runtimeHeaders,
          "x-akeru-browser-mcp-url": browser.browserUrl,
          "x-akeru-browser-mcp-session-id": browser.mcpSessionId,
          "x-akeru-browser-mcp-headers": JSON.stringify(browser.requestHeaders),
        }
      : runtimeHeaders;
  return {
    url: server.url,
    ...(Object.keys(browserHeaders).length > 0 ? { headers: browserHeaders } : {}),
  };
}

export function mcpServerIdForToolName(
  serverIds: readonly McpServer["id"][],
  toolName: string,
): McpServer["id"] | undefined {
  return serverIds
    .toSorted((left, right) => String(right).length - String(left).length)
    .find((serverId) => toolName.startsWith(`${serverId}_`));
}

function permissionPolicy(
  runtimeMode: RuntimeMode,
  category: ReturnType<typeof akeruToolCategory>,
): "allow" | "ask" {
  if (runtimeMode === "full-access" || runtimeMode === "auto") return "allow";
  if (category === "read") return "allow";
  if (runtimeMode === "auto-accept-edits" && category === "edit") return "allow";
  return "ask";
}

function mcpToolNeedsApproval(manager: McpManager | undefined, toolName: string): boolean {
  const tool = manager?.getTools()?.[toolName] as
    | { readonly mcp?: { readonly annotations?: { readonly readOnlyHint?: boolean } } }
    | undefined;
  if (tool) return tool.mcp?.annotations?.readOnlyHint !== true;
  // Akeru's own tools declare their risk; plain workspace tools follow the bot's mode.
  const akeruTool = AKERU_TOOL_CATALOG.find((entry) => entry.id === toolName);
  if (akeruTool) return akeruTool.approval !== "none";
  if (isMemoryToolId(toolName)) return false;
  return !BUILTIN_MASTRA_TOOL_NAMES.has(toolName);
}

function approvalDetail(toolName: string, action: string | null, oneUse: boolean): string {
  if (!oneUse) return `Allow ${toolName}?`;
  const target = action ? `${action} action with ${toolName}` : `action with ${toolName}`;
  return `Approve this ${target}? This approval applies only to the pending action. It cannot undo completed work.`;
}

/**
 * Providers whose bots run through Akeru's Mastra controller and receive the
 * Akeru tool catalog. Standard OpenCode stays on the legacy bridge, which never
 * registers a tool session, so it gets no catalog tools, workers included.
 * These are exactly the drivers that can delegate, so the delegation gate and
 * this routing never disagree.
 */
export function usesMastraCode(provider: ProviderDriverKind): boolean {
  return driverSupportsDelegation(provider);
}

function disabledProviderError(
  operation: string,
  providerInstanceId: ProviderInstanceId,
): ProviderValidationError {
  return new ProviderValidationError({
    operation,
    issue: `Provider instance '${providerInstanceId}' is disabled in Akeru Bot settings.`,
  });
}

function subscriptionProviderForDriver(
  provider: ProviderDriverKind,
): SubscriptionProviderId | undefined {
  switch (String(provider)) {
    case "codex":
      return "openai-codex";
    case "claudeAgent":
      return "anthropic";
    case "grok":
      return "xai";
    case "kimi":
      return "kimi-for-coding";
    case "opencodeGo":
      return "opencode-go";
    default:
      return undefined;
  }
}

export function mastraConnectionIssue(
  provider: ProviderDriverKind,
  connection: ProviderInstanceRoutingInfo["mastraConnection"],
  savedCredentialConnected: boolean,
): string | undefined {
  if (!connection) return undefined;
  const env = connection.useSavedCredential
    ? connection.environment
    : connection.instanceEnvironment;
  if (connection.useSavedCredential) {
    const hasAmbientCredential = (() => {
      switch (String(provider)) {
        case "codex":
          return Boolean(env.OPENAI_API_KEY?.trim());
        case "claudeAgent":
          return Boolean(
            env.ANTHROPIC_API_KEY?.trim() ||
            env.ANTHROPIC_AUTH_TOKEN?.trim() ||
            env.CLAUDE_CODE_OAUTH_TOKEN?.trim(),
          );
        case "grok":
          return Boolean(env.XAI_API_KEY?.trim());
        case "opencodeGo":
          return Boolean(env.OPENCODE_API_KEY?.trim() || openCodeGoInlineConnection(env).apiKey);
        default:
          return false;
      }
    })();
    if (hasAmbientCredential) return undefined;
    return savedCredentialConnected
      ? undefined
      : `Connect ${provider} in Settings before starting.`;
  }
  switch (String(provider)) {
    case "codex":
      return env.OPENAI_API_KEY?.trim()
        ? undefined
        : "This Codex instance needs OPENAI_API_KEY for the Akeru harness.";
    case "claudeAgent":
      return env.ANTHROPIC_API_KEY?.trim() ||
        env.ANTHROPIC_AUTH_TOKEN?.trim() ||
        env.CLAUDE_CODE_OAUTH_TOKEN?.trim()
        ? undefined
        : "This Claude instance needs an API key or auth token for the Akeru harness.";
    case "grok":
      return env.XAI_API_KEY?.trim()
        ? undefined
        : "This Grok instance needs XAI_API_KEY for the Akeru harness.";
    case "kimi":
      return "Custom Kimi credentials are not supported by the Akeru harness.";
    case "opencodeGo":
      return env.OPENCODE_API_KEY?.trim() || openCodeGoInlineConnection(env).apiKey
        ? undefined
        : "This OpenCode Go instance needs OPENCODE_API_KEY for the Akeru harness.";
    default:
      return `Provider '${provider}' has no Akeru Mastra transport.`;
  }
}

export function recordProviderAccessHealth(
  subscriptionAuth: SubscriptionAuthService,
  event: ProviderRuntimeEvent,
  model?: string,
): void {
  const provider = subscriptionProviderForDriver(event.provider);
  const providerInstanceId = event.providerInstanceId;
  if (event.type === "turn.completed") {
    if (event.payload.state === "failed") {
      const message = event.payload.errorMessage ?? "The provider request failed.";
      if (provider) {
        if (providerInstanceId)
          subscriptionAuth.recordAccountRequestFailure(
            provider,
            providerInstanceId,
            message,
            event.createdAt,
          );
        else subscriptionAuth.recordRequestFailure(provider, message, event.createdAt);
      }
      if (providerInstanceId) {
        subscriptionAuth.recordProviderInstanceFailure(
          providerInstanceId,
          message,
          event.createdAt,
          model,
        );
      }
    } else if (event.payload.state === "completed") {
      if (provider) {
        if (providerInstanceId)
          subscriptionAuth.recordAccountRequestSuccess(
            provider,
            providerInstanceId,
            event.createdAt,
          );
        else subscriptionAuth.recordRequestSuccess(provider, event.createdAt);
      }
      if (providerInstanceId) {
        subscriptionAuth.recordProviderInstanceSuccess(providerInstanceId, event.createdAt);
      }
    }
    return;
  }
  if (event.type !== "runtime.error" || event.payload.class !== "provider_error") return;
  if (provider) {
    if (providerInstanceId)
      subscriptionAuth.recordAccountRequestFailure(
        provider,
        providerInstanceId,
        event.payload.message,
        event.createdAt,
      );
    else subscriptionAuth.recordRequestFailure(provider, event.payload.message, event.createdAt);
  }
  if (providerInstanceId) {
    subscriptionAuth.recordProviderInstanceFailure(
      providerInstanceId,
      event.payload.message,
      event.createdAt,
      model,
    );
  }
}

function itemType(
  toolName: string,
): "command_execution" | "file_change" | "mcp_tool_call" | "dynamic_tool_call" {
  if (/execute|command|shell|terminal/i.test(toolName)) return "command_execution";
  if (/edit|write|delete|mkdir|file/i.test(toolName)) return "file_change";
  if (/mcp/i.test(toolName)) return "mcp_tool_call";
  return "dynamic_tool_call";
}

const make = (options?: AgentControllerLiveOptions) =>
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const hostPlatform = yield* HostProcessPlatform;
    const legacyProviderBridge = yield* LegacyProviderBridge;
    const botUsageLedger = yield* BotUsageLedger;
    const serverSettings = yield* Effect.serviceOption(ServerSettings.ServerSettingsService);
    const mcpSessionRegistry = yield* Effect.serviceOption(McpSessionRegistry.McpSessionRegistry);
    // Promise-based callers re-enter Effect only through this seam; its fibers
    // are interrupted when the layer scope closes.
    const { runPromise, fork, forkPromise } = yield* makeAkeruRuntimeSeam;
    const routineDraftDispatcher = yield* Effect.serviceOption(RoutineDraftDispatcher);
    const memoryApprovals = yield* Effect.serviceOption(MemoryApprovals);
    const routineDispatcher = Option.getOrUndefined(routineDraftDispatcher);
    const mutationLock = yield* Semaphore.make(1);
    const runtimeEvents = yield* PubSub.unbounded<ProviderRuntimeEvent>();
    const orchestrationEngine = yield* Effect.serviceOption(OrchestrationEngineService);
    const projectionSnapshotQuery = yield* Effect.serviceOption(ProjectionSnapshotQuery);
    const projectionMessages = yield* Effect.serviceOption(ProjectionThreadMessageRepository);
    const projectionTurns = yield* Effect.serviceOption(ProjectionTurnRepository);
    const resolvedByThread = new Map<string, ResolvedEngine>();
    const webFetch = createAkeruWebFetch(options?.webFetch);
    const modelConnections = new Map<
      string,
      NonNullable<ProviderInstanceRoutingInfo["mastraConnection"]>
    >();
    const sessions = new Map<string, ActiveSession>();
    // Tool calls consume no model tokens, so their entries hold no cap while they run.
    // `persisted` is false when the start write failed; finish then writes the whole entry.
    const toolUsageStarts = new Map<
      string,
      {
        persisted: boolean;
        readonly turnId: TurnId | null;
        readonly provider: ProviderDriverKind | null;
        readonly model: string | null;
      }
    >();
    // Providers only promise tool-call ids unique within a chat.
    const toolUsageKey = (input: { readonly threadId: string; readonly toolCallId: string }) =>
      `tool:${input.threadId}:${input.toolCallId}`;
    const legacyHiddenWakeByTurn = new Map<string, boolean>();
    // Memory calls with no live turn reservation, recorded when they finish.
    const unreservedMemoryCalls = new Map<
      string,
      {
        readonly botId: BotId;
        readonly threadId: ThreadId;
        readonly category: "observer" | "reflector";
        readonly provider: ProviderDriverKind | null;
        readonly model: string | null;
      }
    >();
    const memoryUsageByThread = new Map<
      string,
      { readonly botId: BotId; readonly capLimit: number; turnId: TurnId }
    >();
    const issueMcpCredential =
      options?.issueMcpCredential ??
      (Option.isSome(mcpSessionRegistry)
        ? (request: McpSessionRegistry.McpCredentialRequest) =>
            mcpSessionRegistry.value.revokeThread(request.threadId).pipe(
              Effect.andThen(mcpSessionRegistry.value.issue(request)),
              Effect.map((credential) => ({ config: credential.config })),
            )
        : McpSessionRegistry.issueActiveMcpCredential);
    const revokeMcpCredential =
      options?.revokeMcpCredential ??
      (Option.isSome(mcpSessionRegistry)
        ? mcpSessionRegistry.value.revokeThread
        : McpSessionRegistry.revokeActiveMcpThread);
    const clearPreviewMcpSession = (threadId: ThreadId) =>
      revokeMcpCredential(threadId).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            McpProviderSession.clearMcpProviderSession(threadId);
            McpMemoryToolSession.clearMcpMemoryToolSession(threadId);
          }),
        ),
      );
    const preparePreviewMcpSession = (
      threadId: ThreadId,
      providerInstanceId: ProviderInstanceId,
      memoryHandler?: AkeruMemoryToolHandler,
    ) =>
      Effect.gen(function* () {
        // Matches ProviderService's capabilities: an unreadable settings file withholds both.
        const { previewEnabled, imageEnabled } = Option.isSome(serverSettings)
          ? yield* serverSettings.value.getSettings.pipe(
              Effect.map((settings) => ({
                previewEnabled: settings.enableAgentBrowserAccess,
                imageEnabled:
                  settings.imageGeneration.chatgptEnabled || settings.imageGeneration.grokEnabled,
              })),
              Effect.orElseSucceed(() => ({ previewEnabled: false, imageEnabled: false })),
            )
          : { previewEnabled: true, imageEnabled: false };
        const capabilities = new Set<McpInvocationContext.McpCapability>([
          ...(previewEnabled ? (["preview"] as const) : []),
          ...(imageEnabled ? (["image"] as const) : []),
          ...(memoryHandler ? (["memory"] as const) : []),
        ]);
        if (capabilities.size === 0) {
          yield* clearPreviewMcpSession(threadId);
          return;
        }
        const credential = yield* issueMcpCredential({
          threadId,
          providerInstanceId,
          capabilities,
        });
        if (credential) {
          yield* Effect.sync(() => {
            McpProviderSession.setMcpProviderSession(credential.config);
            if (memoryHandler) {
              McpMemoryToolSession.setMcpMemoryToolSession(threadId, memoryHandler);
            } else {
              McpMemoryToolSession.clearMcpMemoryToolSession(threadId);
            }
          });
        }
      });
    /**
     * Orchestration-backed runtimes. The orchestration layer is built after this
     * controller, so it hands them over through configurePluginRuntime and
     * configureDelegation.
     */
    const lateWiring = yield* Ref.make<{
      readonly channelRuntime?: AkeruChannelRuntime;
      readonly pluginRuntime?: ReturnType<typeof createAkeruPluginRuntime>;
      readonly pluginRuntimeOptions?: AkeruPluginRuntimeOptions;
      readonly botStateRuntime?: AkeruBotStateRuntime;
      readonly delegationRuntime?: AgentControllerLiveOptions["delegationRuntime"];
      readonly workerOrchestration?: WorkerOrchestration;
    }>({ delegationRuntime: options?.delegationRuntime });
    const wired = () => Ref.getUnsafe(lateWiring);
    const childWaiters = yield* makePendingWaiters<null, AkeruDelegationChildOutcome>(
      "The agent controller stopped.",
    );
    const resolveChildWaiter = (threadId: ThreadId, outcome: AkeruDelegationChildOutcome) => {
      childWaiters.resolve(String(threadId), outcome);
    };
    const pendingRoutineRequests = yield* makePendingWaiters<
      {
        readonly threadId: string;
        readonly input: AkeruCreateRoutineInput;
        readonly timezone: string;
      },
      unknown,
      Error
    >("The agent controller stopped before the routine review finished.");
    // Accepted routine reviews whose routine is still being created, by tool call.
    const creatingRoutineReviews = new Map<string, string>();
    // A turn waits on the user while any tool approval, question, or routine review
    // it opened is unanswered, or an accepted routine is still being created.
    const turnStillWaiting = (threadId: string, active: ActiveSession) =>
      active.pendingApprovals.size > 0 ||
      (active.activeTurn?.suspendedToolCalls.size ?? 0) > 0 ||
      pendingRoutineRequests.entries().some(([, request]) => request.threadId === threadId) ||
      [...creatingRoutineReviews.values()].includes(threadId);

    /** Calls out to a Promise-based library and types its failure. */
    const runMastra = <A>(operation: string, run: (signal: AbortSignal) => Promise<A>) =>
      Effect.tryPromise({
        try: run,
        catch: (cause) =>
          new AgentControllerRuntimeError({
            operation,
            detail: failureDetail(cause),
            cause,
          }),
      });

    yield* Effect.sync(() => {
      NodeFS.mkdirSync(config.stateDir, { recursive: true, mode: 0o700 });
    });

    const authStorage = createAkeruMastraAuthStorage(config.secretsDir);
    const subscriptionAuth = yield* SubscriptionAuthService.forSecretsDir(config.secretsDir);
    const botInbox = BotInboxService.forSecretsDir(config.secretsDir);
    const sessionResources = new AkeruSessionResources({
      stateDir: config.stateDir,
      hostPlatform,
      getPreviewMcpServerConfig: (threadId) => {
        const session = McpProviderSession.readMcpProviderSession(ThreadId.make(threadId));
        return session
          ? {
              url: session.endpoint,
              headers: { Authorization: session.authorizationHeader },
            }
          : undefined;
      },
      toMcpServerConfigs,
      onMcpServerConnectionFailure: (serverId) =>
        subscriptionAuth.recordMcpRequestFailure(serverId, "The MCP server failed to connect."),
      onBrowserFailure: (input) => recordBrowserFailure(botInbox, input),
      onBrowserReady: (botId, resourceKey) => resolveBrowserFailure(botInbox, botId, resourceKey),
      ...(options?.makeMcpManager ? { makeMcpManager: options.makeMcpManager } : {}),
      ...(options?.makeRemoteWorkspace ? { makeRemoteWorkspace: options.makeRemoteWorkspace } : {}),
      ...(options?.makeBotBrowser ? { makeBotBrowser: options.makeBotBrowser } : {}),
      ...(options?.resolveComputerUseServer
        ? { resolveComputerUseServer: options.resolveComputerUseServer }
        : {}),
    });
    const botMemoryStore = options?.botMemoryStore ?? new BotMemoryStore(config.stateDir);
    const memoryTurnHarness = new AkeruMemoryTurnHarness(botMemoryStore);
    const toolRuntime = createAkeruToolRuntime({
      onUserActionRequired: (input) => {
        recordUserActionIncident(botInbox, input);
      },
      onReceipt: (receipt) => {
        const active = sessions.get(String(receipt.threadId));
        if (!active) return;
        PubSub.publishUnsafe(runtimeEvents, {
          eventId: eventId(),
          provider: active.provider,
          providerInstanceId: active.providerInstanceId,
          threadId: receipt.threadId,
          ...(active.activeTurn ? { turnId: active.activeTurn.turnId } : {}),
          type: "tool.receipt",
          payload: receipt,
          createdAt: receipt.createdAt,
        });
      },
      onToolStart: async (input, session) => {
        if (!session.botId) return;
        const key = toolUsageKey(input);
        const active = sessions.get(input.threadId);
        const started = {
          persisted: false,
          turnId: active?.activeTurn?.turnId ?? null,
          provider: active?.provider ?? null,
          model: active?.model ?? null,
        };
        toolUsageStarts.set(key, started);
        await runPromise(
          botUsageLedger
            .recordStart({
              reservationId: AkeruUsageReservationId.make(key),
              sourceKey: key,
              botId: session.botId,
              threadId: ThreadId.make(input.threadId),
              turnId: started.turnId,
              category: "tool",
              provider: started.provider,
              model: started.model,
              createdAt: nowIso(),
            })
            .pipe(
              Effect.tap(() =>
                Effect.sync(() => {
                  started.persisted = true;
                }),
              ),
              Effect.catchCause((cause) =>
                Effect.logWarning("failed to record tool start", {
                  toolCallId: input.toolCallId,
                  cause,
                }),
              ),
            ),
        );
      },
      onToolFinish: async (input, session) => {
        const key = toolUsageKey(input);
        const started = toolUsageStarts.get(key);
        toolUsageStarts.delete(key);
        if (!session.botId || !started) return;
        await runPromise(
          (started.persisted
            ? botUsageLedger.settle({
                reservationId: AkeruUsageReservationId.make(key),
                state: "reported",
                inputTokens: 0,
                outputTokens: 0,
                reasoningTokens: null,
                settledAt: nowIso(),
              })
            : botUsageLedger.recordMeasurement({
                reservationId: AkeruUsageReservationId.make(key),
                sourceKey: key,
                botId: session.botId,
                threadId: ThreadId.make(input.threadId),
                turnId: started.turnId,
                category: "tool",
                inputTokens: 0,
                outputTokens: 0,
                reasoningTokens: null,
                provider: started.provider,
                model: started.model,
                createdAt: nowIso(),
              })
          ).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("failed to record tool usage", {
                toolCallId: input.toolCallId,
                cause,
              }),
            ),
          ),
        );
      },
      onProgress: ({ threadId, toolId, toolCallId, summary, authorizationUrl }) => {
        const active = sessions.get(threadId);
        if (!active) return;
        PubSub.publishUnsafe(runtimeEvents, {
          ...baseEvent(ThreadId.make(threadId), active, active.activeTurn?.turnId),
          type: "tool.receipt",
          payload: {
            receiptId: toolCallId,
            toolId,
            phase: "progress",
            threadId: ThreadId.make(threadId),
            ...(active.toolSession.botId ? { botId: active.toolSession.botId } : {}),
            summary,
            ...(authorizationUrl ? { authorizationUrl } : {}),
            fatalToThread: false,
            createdAt: nowIso(),
          },
        });
      },
    });
    const memoryAccessFor = (
      access: AkeruMemoryThreadAccess | undefined,
    ): BotMemoryAccess | undefined => {
      const botId = access?.respondingBotId ?? access?.botId;
      return access && botId
        ? {
            botId,
            groupId: access.groupId,
            groupMemberBotIds: access.groupMemberBotIds,
          }
        : undefined;
    };
    const refreshEntityMemoryAccess = async (
      access: AkeruMemoryThreadAccess | undefined,
    ): Promise<AkeruMemoryThreadAccess | undefined> => {
      if (!access || access.groupId === null) return access;
      // Without a projection the membership cannot be rechecked. The access stays a group
      // access with no members, so it reads neither group facts nor the bot's private ones.
      if (Option.isNone(projectionSnapshotQuery)) {
        return { ...access, groupMemberBotIds: [] };
      }
      const snapshot = await runPromise(projectionSnapshotQuery.value.getSnapshot());
      const group = snapshot.groups.find((candidate) => candidate.id === access.groupId);
      if (!group) return undefined;
      const groupMemberBotIds = group.members
        .filter((member) => member.kind === "bot")
        .map((member) => member.botId);
      const respondingBotId = access.respondingBotId ?? access.botId;
      if (respondingBotId === null || !groupMemberBotIds.includes(respondingBotId))
        return undefined;
      return { ...access, groupMemberBotIds };
    };
    const entityMemoryContext = async (
      access: AkeruMemoryThreadAccess | undefined,
    ): Promise<string> => {
      const current = await refreshEntityMemoryAccess(access);
      if (!current || !options?.entityMemoryRepository) return "";
      if (current.groupId !== null && current.groupMemberBotIds.length === 0) return "";
      const currentRevisions = await runPromise(
        options.entityMemoryRepository.listCurrent({ access: current }),
      );
      // Memory inspection and export still list bot-private facts; only the
      // provider packet honours the Private bot memory switch.
      const { privateBotMemory } = await runPromise(memorySettings());
      const revisions = privateBotMemory
        ? currentRevisions
        : currentRevisions.filter(
            (revision) =>
              revision.partition.scope !== "bot" && revision.partition.scope !== "bot-user",
          );
      await runPromise(
        options.entityMemoryRepository.recordDerivedCopies?.({
          tenantId: current.tenantId,
          threadId: String(current.threadId),
          revisions,
        }) ?? Effect.void,
      );
      const packet = buildProviderMemoryPacket(current.threadId, revisions);
      return packet.rendered ? `<entity-memory>\n${packet.rendered}\n</entity-memory>` : "";
    };
    const memoryHandlers = (
      access: AkeruMemoryThreadAccess | undefined,
      allowedScopes: AkeruDelegationAccessGrant["memoryScopes"],
    ) => {
      const resolved = memoryAccessFor(access);
      if (!resolved) return undefined;
      const scopes = new Set(allowedScopes);
      const targets = new Set<AkeruMemoryDocumentTarget>();
      if (scopes.has("private")) targets.add("user");
      if (scopes.has("bot")) targets.add("memory");
      if (resolved.groupId !== null && scopes.has("group")) targets.add("group");
      const canShare =
        scopes.has("project") ||
        scopes.has("workspace") ||
        (resolved.groupId !== null && scopes.has("group"));
      if (targets.size === 0 && !(canShare && Option.isSome(memoryApprovals))) return undefined;
      // Shared facts go through MemoryApprovals, which saves them directly in
      // auto mode or opens an approval card and inbox item in ask mode.
      const shareFact: AkeruMemoryShareFact | undefined =
        access && Option.isSome(memoryApprovals)
          ? async (request) => {
              if (!scopes.has(request.scope)) {
                throw new Error(
                  `The ${request.scope} memory scope is outside this bot's access grant.`,
                );
              }
              if (request.scope === "group" && access.groupId === null) {
                throw new Error("Group memory is available only in a group chat.");
              }
              const settings = await runPromise(memorySettings());
              const result = await runPromise(
                memoryApprovals.value.propose({
                  access,
                  fact: request.fact,
                  scope: request.scope,
                  sensitive: request.sensitive,
                  mode: settings.sharedProjectMemory,
                }),
              );
              return { status: result.status };
            }
          : undefined;
      const handler = createBotMemoryToolHandler(
        botMemoryStore,
        resolved,
        targets,
        shareFact,
      ).memory;
      // The memory settings gate is enforced at call time: a handler captured
      // while Memory was on must deny calls after it is turned off, and a
      // "Private bot memory" toggle applies without rebuilding the session.
      const guarded: AkeruMemoryToolHandler = async (input) => {
        const settings = await runPromise(memorySettings());
        if (!settings.enabled) {
          throw new Error("Bot memory is disabled.");
        }
        if (!settings.privateBotMemory) {
          const { target, operations, share } = input.input as {
            readonly target?: AkeruMemoryDocumentTarget;
            readonly operations?: ReadonlyArray<unknown>;
            readonly share?: unknown;
          };
          // A share-only call never reads or changes the target document.
          const shareOnly = share !== undefined && operations?.length === 0;
          if (target === "memory" && !shareOnly) {
            throw new Error("Private bot memory is disabled.");
          }
        }
        return handler(input);
      };
      return { memory: guarded };
    };
    // Image providers for the GenerateImage tool, read on every session start or reuse. An
    // unreadable settings file hides the tool rather than offering a call that can only fail
    // (ProviderService denies the MCP capability the same way). Without the service, tests
    // keep the tool visible.
    const imageToolSettings = Option.isSome(serverSettings)
      ? serverSettings.value.getSettings.pipe(
          Effect.map((settings) => settings.imageGeneration),
          Effect.orElseSucceed(() => ({ chatgptEnabled: false, grokEnabled: false })),
          Effect.map(({ chatgptEnabled, grokEnabled }) => ({ chatgptEnabled, grokEnabled })),
        )
      : Effect.succeed({ chatgptEnabled: true, grokEnabled: true });
    const memorySettings = () =>
      Option.isSome(serverSettings)
        ? serverSettings.value.getSettings.pipe(
            Effect.map((settings) => ({
              enabled: settings.memory.enabled,
              privateBotMemory: settings.memory.privateBotMemory,
              sharedProjectMemory: settings.memory.sharedProjectMemory,
            })),
            // Fail closed: an unreadable setting must not re-enable memory the user turned off.
            Effect.orElseSucceed(() => ({
              ...DEFAULT_MEMORY_TOOL_SETTINGS,
              enabled: false,
              privateBotMemory: false,
            })),
          )
        : Effect.succeed(DEFAULT_MEMORY_TOOL_SETTINGS);
    const memoryAccessKey = (access: BotMemoryAccess | undefined): string | undefined =>
      access ? `${access.botId}:${access.groupId ?? "private"}` : undefined;
    const legacyResourceIdentity = new Map<string, LegacyResourceIdentity>();
    const legacyTurnMemory = new Map<string, Array<LegacyTurnMemoryState>>();
    const legacyPending = (key: string) => legacyTurnMemory.get(key) ?? [];
    const addLegacyPending = (key: string, pending: LegacyTurnMemoryState) =>
      legacyTurnMemory.set(key, [...legacyPending(key), pending]);
    const removeLegacyPending = (key: string, pending: LegacyTurnMemoryState) => {
      const remaining = legacyPending(key).filter((entry) => entry !== pending);
      if (remaining.length > 0) legacyTurnMemory.set(key, remaining);
      else legacyTurnMemory.delete(key);
    };
    const hasLegacyPending = (key: string, pending: LegacyTurnMemoryState) =>
      legacyPending(key).includes(pending);
    const restoreLegacyMemoryHandler = (key: string, pending: LegacyTurnMemoryState) => {
      if (
        !pending.reviewMemoryHandler ||
        McpMemoryToolSession.readMcpMemoryToolSession(ThreadId.make(key)) !==
          pending.reviewMemoryHandler
      ) {
        return;
      }
      if (pending.priorMemoryHandler) {
        McpMemoryToolSession.setMcpMemoryToolSession(
          ThreadId.make(key),
          pending.priorMemoryHandler,
        );
      } else {
        McpMemoryToolSession.clearMcpMemoryToolSession(ThreadId.make(key));
      }
    };
    const legacyBufferedTerminals = new Map<string, Map<string, ProviderRuntimeEvent>>();
    const mastraMemoryTurns = new Map<string, AkeruMemoryTurn>();
    const mastraReservationKey = (threadId: ThreadId, turnId: TurnId) =>
      `${String(threadId)}:${String(turnId)}`;
    const releaseMastraReservations = (threadId: ThreadId) =>
      Effect.forEach(
        [...mastraMemoryTurns.entries()].filter(([key]) => key.startsWith(`${String(threadId)}:`)),
        ([key, memoryTurn]) =>
          runMastra("memory.abandon", () => memoryTurn.abandon()).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                if (mastraMemoryTurns.get(key) === memoryTurn) {
                  mastraMemoryTurns.delete(key);
                }
              }),
            ),
            Effect.ignoreCause({ log: true }),
          ),
        { discard: true },
      );
    const settleLegacyTurnMemory = (
      key: string,
      pending: LegacyTurnMemoryState,
      event: ProviderRuntimeEvent,
    ) =>
      Effect.gen(function* () {
        if (!hasLegacyPending(key, pending)) return;
        const foregroundSucceeded =
          event.type === "turn.completed" && event.payload.state === "completed";
        // Delegated children on legacy providers report back through the same waiter as Mastra.
        const assistantText = pending.assistant.trim();
        resolveChildWaiter(ThreadId.make(key), {
          state: foregroundSucceeded ? "completed" : "failed",
          turnId: event.turnId ?? null,
          ...(foregroundSucceeded && assistantText
            ? { summary: assistantText }
            : {
                error:
                  (event.type === "turn.completed" ? event.payload.errorMessage : undefined) ??
                  "The delegated turn did not finish.",
              }),
        });
        if (!foregroundSucceeded) {
          restoreLegacyMemoryHandler(key, pending);
          removeLegacyPending(key, pending);
          if (pending.memoryTurn) {
            yield* runMastra("memory.finishForeground", () =>
              pending.memoryTurn!.finishForeground(false, "foreground"),
            ).pipe(Effect.ignoreCause({ log: true }));
          }
          return;
        }
        if (pending.memoryTurn) {
          yield* runMastra("memory.finishForeground", () =>
            pending.memoryTurn!.finishForeground(true, "foreground"),
          ).pipe(Effect.ignoreCause({ log: true }));
        }
        const mergedPrompts = legacyPending(key).filter(
          (entry) => entry.turnId !== undefined && entry.turnId === pending.turnId,
        );
        if (
          mergedPrompts[0] === pending &&
          !pending.observationRecorded &&
          mergedPrompts.some((entry) => entry.assistant.trim()) &&
          bundle.observeExternalTurn
        ) {
          for (const entry of mergedPrompts) entry.observationRecorded = true;
          const assistant = mergedPrompts
            .map((entry) => entry.assistant)
            .toSorted((left, right) => right.length - left.length)[0]!;
          const observeExternalTurn = bundle.observeExternalTurn;
          const turnId = pending.turnId ?? `legacy-${event.eventId}`;
          forkPromise(
            "Akeru background observational memory failed.",
            () =>
              observeExternalTurn({
                threadId: key,
                turnId,
                modelId: pending.modelId,
                userMessages: mergedPrompts.map((entry) => ({
                  id: entry.observationPromptId,
                  text: entry.user,
                })),
                assistant,
                createdAt: event.createdAt,
              }),
            { annotations: { threadId: key, turnId } },
          );
        }
        removeLegacyPending(key, pending);
        if (pending.memoryTurn?.reviewIncluded) {
          restoreLegacyMemoryHandler(key, pending);
        }
      });
    const drainLegacyTerminals = (key: string) =>
      Effect.gen(function* () {
        const pendingTurns = legacyPending(key);
        if (pendingTurns.some((pending) => !pending.dispatchReturned)) return;
        const terminals = legacyBufferedTerminals.get(key);
        if (!terminals) return;
        for (const [turnId, terminal] of terminals) {
          const matching = legacyPending(key).filter((pending) => pending.turnId === turnId);
          for (const pending of matching) {
            yield* settleLegacyTurnMemory(key, pending, terminal);
          }
          terminals.delete(turnId);
        }
        if (terminals.size === 0) legacyBufferedTerminals.delete(key);
      });
    const delegationFor = (input: {
      readonly threadId: ThreadId;
      readonly botId: BotId;
      readonly parentDelegation: AkeruDelegationRecord | undefined;
      readonly access: AkeruDelegationAccessGrant;
      readonly activeChildDelegations: number;
    }): NonNullable<AkeruToolSession["delegation"]> => {
      const delegationRuntime = wired().delegationRuntime;
      const parent = () => {
        const turnId = sessions.get(String(input.threadId))?.activeTurn?.turnId;
        if (!turnId || !delegationRuntime) {
          throw new Error("Bot management requires an active parent turn.");
        }
        return {
          threadId: input.threadId,
          turnId,
          botId: input.botId,
          parentDelegationId: input.parentDelegation?.delegationId ?? null,
          ancestorBotIds: input.parentDelegation?.ancestorBotIds ?? [],
          depth: input.parentDelegation?.depth ?? 0,
          access: input.access,
        };
      };
      const createAgent = delegationRuntime?.create;
      const checkAgent = delegationRuntime?.check;
      const stopAgent = delegationRuntime?.stop;
      return {
        depth: input.parentDelegation?.depth ?? 0,
        activeDelegations: input.activeChildDelegations,
        access: input.access,
        ...(createAgent ? { create: (request) => createAgent(parent(), request) } : {}),
        ...(checkAgent ? { check: (request) => checkAgent(parent(), request) } : {}),
        send: (request) => delegationRuntime!.send(parent(), request),
        ...(stopAgent ? { stop: (request) => stopAgent(parent(), request) } : {}),
      };
    };
    const makeMastraHarness = options?.makeMastraHarness ?? makeAkeruMastraHarness;
    const bundle = yield* makeMastraHarness({
      authStorage,
      getKimiAccess: (instanceId) => subscriptionAuth.getKimiForCodingAccess(instanceId),
      getOpenCodeGoApiKey: async (instanceId) =>
        subscriptionAuth.getApiKeyCredential("opencode-go", instanceId)?.access,
      getSubscriptionApiKey: (provider, instanceId) =>
        subscriptionAuth.getApiKeyCredential(provider, instanceId),
      getSubscriptionOAuth: (provider, instanceId) =>
        subscriptionAuth.getOAuthCredential(provider, instanceId),
      getSubscriptionAccessToken: (provider, instanceId) =>
        subscriptionAuth.getAccessToken(provider, instanceId),
      getModelConnection: (providerInstanceId) => {
        const connection = modelConnections.get(providerInstanceId);
        return connection ? { ...connection, instanceId: providerInstanceId } : undefined;
      },
      memoryDbPath: NodePath.join(config.stateDir, "mastra-observational-memory.sqlite"),
      syncThreadToolApproval: async (threadId, toolName, protectedAction) => {
        const active = sessions.get(threadId);
        const activeTurn = active?.activeTurn;
        if (
          !active ||
          !activeTurn ||
          (!protectedAction && !active.connectorSessionApprovals.has(toolName))
        ) {
          return;
        }
        const update = await runPromise(
          legacyProviderBridge.dispatchIfEnabled(
            active.providerInstanceId,
            "AgentController.syncThreadToolApproval",
            () => {
              if (sessions.get(threadId) !== active || active.activeTurn !== activeTurn) return;
              return active.session.permissions.setForTool({
                toolName,
                policy: protectedAction ? "ask" : "allow",
              });
            },
          ),
        );
        await update;
      },
      getThreadTools: (threadId) => sessionResources.getConnectorTools(threadId),
      // Durable queue rows can drain before any client opens the thread (for
      // example right after a server restart), so the activity must not
      // depend on an active provider session; the row's recorded turnId is
      // the authority and the active turn is only a fallback.
      onObservationDropped: async ({
        observationId,
        threadId,
        turnId,
        resourceId,
        modelId,
        attempts,
        error,
      }) => {
        if (!Option.isSome(orchestrationEngine)) return;
        const active = sessions.get(threadId);
        const droppedAt = nowIso();
        await runPromise(
          orchestrationEngine.value.dispatch({
            type: "thread.activity.append",
            // Stable ids make a retried notice idempotent.
            commandId: CommandId.make(`server:observation-dropped:${observationId}`),
            threadId: ThreadIdBrand(threadId),
            activity: {
              id: EventId.make(`observation-dropped:${observationId}`),
              tone: "error",
              kind: "memory.observation.dropped",
              summary: "Background memory observation dropped after repeated failures",
              payload: {
                resourceId,
                modelId: modelId ?? null,
                attempts,
                detail: error.message,
              },
              turnId: turnId ? TurnId.make(turnId) : (active?.activeTurn?.turnId ?? null),
              createdAt: droppedAt,
            },
            createdAt: droppedAt,
          }),
        );
      },
      ...(routineDispatcher
        ? {
            listRoutines: (threadId: string) =>
              runPromise(
                routineDispatcher
                  .listForThread(ThreadIdBrand(threadId))
                  .pipe(Effect.map((routines) => ({ routines: [...routines] }))),
              ),
            deleteRoutines: (threadId: string, routineIds: ReadonlyArray<string>) =>
              runPromise(
                routineDispatcher
                  .deleteForThread(
                    ThreadIdBrand(threadId),
                    routineIds.map((routineId) => RoutineId.make(routineId)),
                  )
                  .pipe(
                    Effect.map((result) => ({
                      status: result.status,
                      deletedRoutineIds: [...result.routineIds],
                    })),
                  ),
              ),
            createRoutine: (threadId: string, input: AkeruCreateRoutineInput) => {
              const active = sessions.get(threadId);
              const timezone = active?.toolSession.timezone;
              if (!timezone) {
                return Promise.reject(new Error("Send a message before creating a routine."));
              }
              const requestId = `routine-${NodeCrypto.randomUUID()}`;
              return runPromise(
                pendingRoutineRequests
                  .wait(
                    requestId,
                    { threadId, input, timezone },
                    {
                      timeout: AKERU_ROUTINE_REVIEW_TIMEOUT,
                      timeoutMessage:
                        "The routine review expired without a response. Ask again to create the routine.",
                      onOpen: () => {
                        if (active.activeTurn) active.activeTurn.waiting = true;
                        publishSessionState(ThreadIdBrand(threadId), active, "waiting");
                        publish({
                          ...baseEvent(ThreadIdBrand(threadId), active, active.activeTurn?.turnId),
                          requestId: RuntimeRequestId.make(requestId),
                          type: "request.opened",
                          payload: {
                            requestType: "dynamic_tool_call",
                            detail: "Review routine",
                            toolName: AKERU_CREATE_ROUTINE_TOOL_NAME,
                            args: { ...input, timezone },
                            options: [
                              { decision: "accept", label: "Create routine" },
                              { decision: "decline", label: "Cancel" },
                            ],
                          },
                        });
                      },
                    },
                  )
                  .pipe(
                    Effect.tapErrorTag("PendingWaiterTimeoutError", () =>
                      Effect.sync(() => {
                        // Close the review card so the chat no longer waits on the user.
                        const current = sessions.get(threadId);
                        if (!current?.activeTurn) return;
                        current.activeTurn.waiting = turnStillWaiting(threadId, current);
                        publish({
                          ...baseEvent(ThreadIdBrand(threadId), current, current.activeTurn.turnId),
                          requestId: RuntimeRequestId.make(requestId),
                          type: "request.resolved",
                          payload: {
                            requestType: "dynamic_tool_call" as const,
                            decision: "cancel",
                            actor: "system",
                            target: AKERU_CREATE_ROUTINE_TOOL_NAME,
                            outcome: "cancelled",
                          },
                        });
                        publishSessionState(
                          ThreadIdBrand(threadId),
                          current,
                          current.activeTurn.waiting ? "waiting" : "running",
                        );
                      }),
                    ),
                  ),
              );
            },
          }
        : {}),
      toolRuntime,
      startMemoryCall: async ({ threadId, category }) => {
        const context = memoryUsageByThread.get(threadId);
        const active = sessions.get(threadId);
        const callId = `${category}:${NodeCrypto.randomUUID()}`;
        if (!context || !active) {
          // A queued observation can drain after a restart before its chat
          // reopens. Attribute it to the chat's bot and record what it used.
          const botId = await runPromise(
            readSessionStartContext(ThreadIdBrand(threadId), null).pipe(
              Effect.map((started) => started.botId),
              Effect.catchCause(() => Effect.succeed(null)),
            ),
          );
          if (!botId) return undefined;
          unreservedMemoryCalls.set(callId, {
            botId,
            threadId: ThreadIdBrand(threadId),
            category,
            provider: active?.provider ?? null,
            model: active?.model ?? null,
          });
          return callId;
        }
        await runPromise(
          botUsageLedger.reserve({
            reservationId: AkeruUsageReservationId.make(callId),
            sourceKey: callId,
            botId: context.botId,
            threadId: ThreadIdBrand(threadId),
            turnId: context.turnId,
            category,
            maximumTokens: AKERU_TURN_USAGE_RESERVATION_TOKENS,
            capLimit: context.capLimit,
            provider: active.provider,
            model: active.model,
            createdAt: nowIso(),
          }),
        );
        return callId;
      },
      finishMemoryCall: async ({ callId, usage, error }) => {
        const outputTokens = usage?.outputTokens ?? 0;
        const inputTokens =
          usage?.inputTokens ?? Math.max(0, (usage?.totalTokens ?? 0) - outputTokens);
        const unreserved = unreservedMemoryCalls.get(callId);
        if (unreserved) {
          unreservedMemoryCalls.delete(callId);
          if (!usage) return;
          await runPromise(
            botUsageLedger.recordMeasurement({
              reservationId: AkeruUsageReservationId.make(callId),
              sourceKey: callId,
              botId: unreserved.botId,
              threadId: unreserved.threadId,
              turnId: null,
              category: unreserved.category,
              inputTokens,
              outputTokens,
              reasoningTokens: null,
              provider: unreserved.provider,
              model: unreserved.model,
              createdAt: nowIso(),
            }),
          );
          return;
        }
        await runPromise(
          botUsageLedger.settle(
            usage
              ? {
                  reservationId: AkeruUsageReservationId.make(callId),
                  state: "reported",
                  inputTokens,
                  outputTokens,
                  reasoningTokens: null,
                  settledAt: nowIso(),
                }
              : error
                ? {
                    reservationId: AkeruUsageReservationId.make(callId),
                    state: "unavailable",
                    reason: error.message || "Observational Memory usage was unavailable.",
                    settledAt: nowIso(),
                  }
                : {
                    reservationId: AkeruUsageReservationId.make(callId),
                    state: "released",
                    settledAt: nowIso(),
                  },
          ),
        );
      },
    }).pipe(
      Effect.mapError(
        (cause) =>
          new AgentControllerRuntimeError({
            operation: "construct",
            detail: failureDetail(cause),
            cause,
          }),
      ),
    );
    yield* runMastra("init", () => bundle.controller.init());

    const publish = (event: ProviderRuntimeEvent) => {
      PubSub.publishUnsafe(runtimeEvents, event);
    };
    const makeDelegationRuntime = (input: {
      readonly readSnapshot: () => Promise<OrchestrationReadModel>;
      readonly dispatch: (command: OrchestrationCommand) => Promise<unknown>;
    }) =>
      createAkeruDelegationRuntime({
        ...input,
        awaitChild: (threadId, deadline) =>
          runPromise(
            Effect.gen(function* () {
              const now = yield* Clock.currentTimeMillis;
              return yield* childWaiters.wait(
                String(threadId),
                null,
                deadline === null
                  ? {
                      timeout: AKERU_CHILD_WAIT_DEFAULT_TIMEOUT,
                      timeoutMessage: `The bot did not report back within ${Duration.toHours(AKERU_CHILD_WAIT_DEFAULT_TIMEOUT)} hours.`,
                      existsMessage: `Delegation waiter already exists for '${threadId}'.`,
                    }
                  : {
                      timeout: Duration.millis(Date.parse(deadline) - now),
                      timeoutMessage: "The delegation deadline expired.",
                      existsMessage: `Delegation waiter already exists for '${threadId}'.`,
                    },
              );
            }),
          ),
        interruptChild: (threadId, turnId) =>
          input
            .dispatch({
              type: "thread.turn.interrupt",
              commandId: CommandId.make(`delegation:interrupt:${NodeCrypto.randomUUID()}`),
              threadId,
              ...(turnId ? { turnId } : {}),
              createdAt: nowIso(),
            })
            .then(() => undefined),
        providerDriverKind: (instanceId) =>
          runPromise(
            legacyProviderBridge.getInstanceInfo(instanceId).pipe(
              Effect.map((routing): string | null => routing.driverKind),
              Effect.orElseSucceed(() => null),
            ),
          ),
        recordUsage: async (usage) => {
          const active = sessions.get(String(usage.threadId));
          if (active) publish(delegatedUsageReceipt(usage, active));
        },
        onWatchError: (delegationId, cause) =>
          fork(
            "Akeru delegated work could not record its outcome.",
            Effect.fail(failureDetail(cause)),
            { delegationId },
          ),
        onGroupResultSkipped: (delegationId, reason) =>
          fork(
            "Akeru could not log a skipped group result.",
            Effect.logInfo("delegated result not posted to the group chat", {
              delegationId,
              reason,
            }),
          ),
      });
    if (Option.isSome(orchestrationEngine) && Option.isSome(projectionSnapshotQuery)) {
      const orchestration: WorkerOrchestration = {
        readSnapshot: () => runPromise(projectionSnapshotQuery.value.getCommandReadModel()),
        dispatch: (command) => runPromise(orchestrationEngine.value.dispatch(command)),
      };
      yield* Ref.update(lateWiring, (current) => ({
        ...current,
        delegationRuntime: current.delegationRuntime ?? makeDelegationRuntime(orchestration),
        workerOrchestration: orchestration,
      }));
    }

    /** Runtime mode for each hidden worker thread's turns, keyed by child thread id. */
    const workerTurnDefaults = new Map<string, RuntimeMode>();
    const workerCall = <A>(run: (orchestration: WorkerOrchestration) => Promise<A>) =>
      runMastra("worker.orchestration", () => {
        const orchestration = wired().workerOrchestration;
        if (!orchestration) throw new Error("Workers need the orchestration engine.");
        return run(orchestration);
      }).pipe(
        Effect.mapError(
          (error) => new AkeruWorkerError({ reason: "start_failed", detail: error.detail }),
        ),
      );
    const workerRuntime = yield* makeAkeruWorkerRuntime({
      createChild: (spec) =>
        workerCall(async (orchestration) => {
          const snapshot = await orchestration.readSnapshot();
          const parentThread = snapshot.threads.find(
            (candidate) => candidate.id === spec.parentThreadId,
          );
          if (!parentThread) throw new Error(`Chat '${spec.parentThreadId}' was not found.`);
          const botId =
            sessions.get(String(spec.parentThreadId))?.toolSession.botId ??
            parentThread.respondingBotId ??
            parentThread.botId ??
            null;
          const childThreadId = ThreadId.make(
            `${WORKER_THREAD_ID_PREFIX}${NodeCrypto.randomUUID()}`,
          );
          workerTurnDefaults.set(String(childThreadId), parentThread.runtimeMode);
          // A worker is a direct copy of the responding bot, never a group chat,
          // even when the parent is one.
          await orchestration.dispatch({
            type: "thread.create",
            commandId: CommandId.make(`worker:thread:${NodeCrypto.randomUUID()}`),
            threadId: childThreadId,
            projectId: parentThread.projectId,
            botId,
            groupId: null,
            parentThreadId: spec.parentThreadId,
            parentDelegationId: null,
            title: spec.title,
            modelSelection: parentThread.modelSelection,
            runtimeMode: parentThread.runtimeMode,
            interactionMode: "default",
            branch: parentThread.branch,
            worktreePath: parentThread.worktreePath,
            createdAt: nowIso(),
          });
          return childThreadId;
        }),
      messageChild: (childThreadId, text) =>
        workerCall(async (orchestration) => {
          const runtimeMode = workerTurnDefaults.get(String(childThreadId));
          if (!runtimeMode) throw new Error(`Worker chat '${childThreadId}' is not known.`);
          await orchestration.dispatch({
            type: "thread.turn.start",
            commandId: CommandId.make(`worker:turn:${NodeCrypto.randomUUID()}`),
            threadId: childThreadId,
            message: {
              messageId: MessageId.make(`worker-message-${NodeCrypto.randomUUID()}`),
              role: "user",
              text,
              attachments: [],
            },
            runtimeMode,
            interactionMode: "default",
            createdAt: nowIso(),
          });
        }),
      interruptChild: (childThreadId) =>
        workerCall((orchestration) =>
          orchestration.dispatch({
            type: "thread.turn.interrupt",
            commandId: CommandId.make(`worker:interrupt:${NodeCrypto.randomUUID()}`),
            threadId: childThreadId,
            createdAt: nowIso(),
          }),
        ).pipe(Effect.ignoreCause({ log: true })),
      discardChild: (childThreadId) =>
        Effect.sync(() => workerTurnDefaults.delete(String(childThreadId))).pipe(
          Effect.andThen(
            workerCall((orchestration) =>
              orchestration.dispatch({
                type: "thread.delete",
                commandId: CommandId.make(`worker:discard:${NodeCrypto.randomUUID()}`),
                threadId: childThreadId,
              }),
            ),
          ),
          Effect.ignoreCause({ log: true }),
        ),
    });
    const workersFor = (
      threadId: ThreadId,
      access: AkeruDelegationAccessGrant,
    ): NonNullable<AkeruToolSession["workers"]> => {
      const parent = () => {
        const turnId = sessions.get(String(threadId))?.activeTurn?.turnId;
        if (!turnId) throw new Error("Workers require an active turn.");
        return { threadId, turnId, depth: workerRuntime.depthForThread(threadId), access };
      };
      return {
        depth: workerRuntime.depthForThread(threadId),
        spawn: (request) => runPromise(workerRuntime.spawn(parent(), request)),
        check: (request) => runPromise(workerRuntime.check({ threadId }, request)),
        message: (request) => runPromise(workerRuntime.message({ threadId }, request)),
        stop: (request) => runPromise(workerRuntime.stop({ threadId }, request)),
      };
    };

    const queueTurnMemory = (threadId: ThreadId, active: ActiveSession, turn: ActiveTurn) => {
      const resolved = resolvedByThread.get(String(threadId));
      if (turn.memoryQueued || !bundle.observeAfterTurn || !resolved) return;
      turn.memoryQueued = true;
      const observeAfterTurn = bundle.observeAfterTurn;
      forkPromise(
        "Akeru background observational memory failed.",
        () =>
          observeAfterTurn({
            threadId: String(threadId),
            resourceId: String(threadId),
            modelId: resolved.mastraModelId,
            providerInstanceId: active.providerInstanceId,
            turnId: String(turn.turnId),
          }),
        {
          annotations: { threadId, turnId: turn.turnId },
          onFailure: () => {
            turn.memoryQueued = false;
          },
        },
      );
    };

    const baseEvent = (
      threadId: ThreadId,
      active: Pick<ActiveSession, "provider" | "providerInstanceId">,
      turnId?: TurnId,
    ) => ({
      eventId: eventId(),
      provider: active.provider,
      providerInstanceId: active.providerInstanceId,
      threadId,
      createdAt: nowIso(),
      ...(turnId ? { turnId } : {}),
    });

    const publishSessionState = (
      threadId: ThreadId,
      active: ActiveSession,
      state: "ready" | "running" | "waiting" | "stopped" | "error",
      reason?: string,
    ) => {
      active.status =
        state === "running"
          ? "running"
          : state === "error"
            ? "error"
            : state === "stopped"
              ? "closed"
              : "ready";
      publish({
        ...baseEvent(threadId, active, active.activeTurn?.turnId),
        type: "session.state.changed",
        payload: { state, ...(reason ? { reason } : {}) },
      });
    };

    const completeAssistantMessage = (
      threadId: ThreadId,
      active: ActiveSession,
      turn: ActiveTurn,
      message: ActiveAssistantMessage,
    ) => {
      const text = message.text.startsWith(message.publishedText)
        ? message.text.slice(message.publishedText.length)
        : message.text;
      if (text.length === 0) return;
      const itemId = RuntimeItemId.make(
        `mastra-answer-${message.messageId}${message.revision === 0 ? "" : `-${message.revision}`}`,
      );
      publish({
        ...baseEvent(threadId, active, turn.turnId),
        itemId,
        type: "item.started",
        payload: { itemType: "assistant_message", status: "inProgress" },
      });
      publish({
        ...baseEvent(threadId, active, turn.turnId),
        itemId,
        type: "content.delta",
        payload: { streamKind: "assistant_text", delta: text },
      });
      turn.assistantText += text;
      publish({
        ...baseEvent(threadId, active, turn.turnId),
        itemId,
        type: "item.completed",
        payload: { itemType: "assistant_message", status: "completed" },
      });
      message.publishedText = message.text;
      message.revision += 1;
    };

    const completeAssistantMessages = (
      threadId: ThreadId,
      active: ActiveSession,
      turn: ActiveTurn,
    ) => {
      for (const message of turn.assistantMessages.values()) {
        completeAssistantMessage(threadId, active, turn, message);
      }
    };

    const cancelPendingApproval = (
      threadId: ThreadId,
      active: ActiveSession,
      requestId: string,
      pending: PendingApproval,
    ) => {
      publish({
        ...baseEvent(threadId, active, active.activeTurn?.turnId),
        requestId: RuntimeRequestId.make(requestId),
        type: "request.resolved",
        payload: {
          requestType: "dynamic_tool_call",
          decision: "cancel",
          actor: "system",
          target: pending.toolName,
          action: pending.action,
          outcome: "cancelled",
        },
      });
    };

    const cancelAllPendingApprovals = (threadId: ThreadId, active: ActiveSession) => {
      for (const [requestId, pending] of active.pendingApprovals) {
        cancelPendingApproval(threadId, active, requestId, pending);
      }
      active.pendingApprovals.clear();
      active.approvalRequests.clear();
      toolRuntime.clearApprovals(String(threadId));
    };

    const beginPendingTurn = (
      active: ActiveSession,
      { threadId, turnId, botUsage, hiddenWake }: PendingTurn,
    ) => {
      const key = String(threadId);
      if (botUsage) {
        memoryUsageByThread.set(key, { ...botUsage, turnId });
      } else {
        memoryUsageByThread.delete(key);
      }
      active.activeTurn = {
        turnId,
        assistantMessages: new Map(),
        waiting: false,
        suspendedToolCalls: new Set(),
        finished: false,
        inputTokens: 0,
        outputTokens: 0,
        reasoningTokens: 0,
        memoryQueued: false,
        assistantText: "",
      };
      active.status = "running";
      publish({
        ...baseEvent(threadId, active, turnId),
        type: "turn.started",
        payload: { model: active.model, ...(hiddenWake ? { hiddenWake: true } : {}) },
      });
      publishSessionState(threadId, active, "running");
    };

    const failActiveTurn = async (
      active: ActiveSession,
      threadId: ThreadId,
      turnId: TurnId,
      cause: unknown,
    ) => {
      if (active.activeTurn?.turnId !== turnId) return;
      const detail = sessionFailureDetail(active, cause);
      publish({
        ...baseEvent(threadId, active, turnId),
        type: "runtime.error",
        payload: { message: detail, class: "provider_error" },
      });
      finishTurn(threadId, active, "failed", detail);
      await runPromise(
        stopSessionWithResources({ threadId }, false).pipe(
          Effect.catchCause((resetCause) =>
            Effect.logWarning("provider session reset failed", {
              threadId,
              cause: resetCause,
            }),
          ),
        ),
      );
    };

    const handlePendingTurnFailure = (
      active: ActiveSession,
      pending: PendingTurn,
      cause: unknown,
    ) => {
      const ownsAdmission = active.admittingTurn?.turnId === pending.turnId;
      const ownsActiveTurn = active.activeTurn?.turnId === pending.turnId;
      if (!ownsAdmission && !ownsActiveTurn) return Promise.resolve();
      if (ownsAdmission) {
        active.admittingTurn = null;
      }
      if (!active.activeTurn) beginPendingTurn(active, pending);
      return failActiveTurn(active, pending.threadId, pending.turnId, cause);
    };

    const startAdmittedPendingTurn = (active: ActiveSession, pending: PendingTurn) => {
      const { threadId, turnId, message } = pending;
      if (active.admittingTurn?.turnId !== turnId) return;
      const dispatch: Promise<void> = (async () => {
        const settings = pending.memoryAccess ? await runPromise(memorySettings()) : undefined;
        // The settings read is asynchronous; the turn may have been interrupted
        // while it was pending. Only mutate session state if this admission
        // still owns the turn.
        if (active.admittingTurn?.turnId !== turnId) return;
        const memoryAccess =
          pending.memoryAccess && settings?.enabled ? pending.memoryAccess : undefined;
        // Entity memory rides on durable memory access. With Memory off (or a
        // delegated turn without memory) the turn runs without memory, so group
        // membership is only checked when memory is actually in play.
        const entityMemoryAccess = memoryAccess
          ? await refreshEntityMemoryAccess(pending.entityMemoryAccess)
          : undefined;
        if (memoryAccess && pending.entityMemoryAccess && !entityMemoryAccess) {
          active.admittingTurn = null;
          beginPendingTurn(active, pending);
          await failActiveTurn(
            active,
            pending.threadId,
            pending.turnId,
            new Error("The bot is no longer a member of this group."),
          );
          return;
        }
        if (settings) active.privateBotMemory = settings.privateBotMemory;
        active.memoryAccess = memoryAccess;
        if (!memoryAccess) {
          // Memory was turned off after the turn was queued: drop the memory
          // tool handler so the bot cannot read or change facts. A delegated
          // turn never has durable access, so it keeps the handler its grant
          // built; that handler checks the Memory setting on every call.
          const toolSession = { ...pending.toolSession };
          if (pending.memoryAccess) delete toolSession.memoryHandlers;
          active.toolSession = toolSession;
          toolRuntime.registerSession(String(threadId), active.toolSession);
          const { persistentMemoryContext, ...stateWithoutMemory } = active.session.state.get();
          if (pending.delegationResults) {
            await active.session.state.set({
              ...stateWithoutMemory,
              persistentMemoryContext: pending.delegationResults,
            });
          } else if (persistentMemoryContext) {
            await active.session.state.set(stateWithoutMemory);
          }
          if (active.admittingTurn?.turnId !== turnId) return;
          active.admittingTurn = null;
          beginPendingTurn(active, pending);
          await active.session.sendMessage(message);
          return;
        }
        {
          active.toolSession = pending.toolSession;
          const memoryTurn = await memoryTurnHarness.admit({
            access: memoryAccess,
            input: {
              threadId: String(threadId),
              groupId: memoryAccess.groupId === null ? null : String(memoryAccess.groupId),
              text: pending.reviewInput.slice(0, 4_000),
            },
            privateBotMemory: active.privateBotMemory,
          });
          const reservationKey = mastraReservationKey(threadId, turnId);
          mastraMemoryTurns.set(reservationKey, memoryTurn);
          let accepted = false;
          let reviewToolSession: AkeruToolSession | undefined;
          try {
            const memoryHandler = pending.toolSession.memoryHandlers?.memory;
            if (memoryTurn.reviewIncluded && memoryHandler) {
              reviewToolSession = {
                ...pending.toolSession,
                memoryHandlers: {
                  memory: memoryTurn.wrapMemoryHandler(memoryHandler),
                },
              };
              active.toolSession = reviewToolSession;
            }
            toolRuntime.registerSession(String(threadId), active.toolSession);
            const currentState = active.session.state.get();
            const { persistentMemoryContext: _priorMemoryContext, ...stateWithoutMemory } =
              currentState;
            const entityPacket = await entityMemoryContext(entityMemoryAccess);
            const persistentMemoryContext = [
              memoryTurn.context,
              entityPacket,
              pending.delegationResults,
            ]
              .filter(Boolean)
              .join("\n\n");
            await active.session.state.set({
              ...stateWithoutMemory,
              ...(persistentMemoryContext ? { persistentMemoryContext } : {}),
            });
            if (active.admittingTurn?.turnId !== turnId) return;
            active.admittingTurn = null;
            beginPendingTurn(active, pending);
            await active.session.sendMessage(message);
            accepted = true;
          } finally {
            await memoryTurn.finishForeground(accepted, "foreground");
            if (reviewToolSession && active.toolSession === reviewToolSession) {
              active.toolSession = active.configuredToolSession;
              toolRuntime.registerSession(String(threadId), active.toolSession);
            }
            if (mastraMemoryTurns.get(reservationKey) === memoryTurn) {
              mastraMemoryTurns.delete(reservationKey);
            }
          }
        }
      })();
      active.pendingDispatches.add(dispatch);
      void dispatch.then(
        () => active.pendingDispatches.delete(dispatch),
        () => active.pendingDispatches.delete(dispatch),
      );
      forkPromise(
        "Akeru turn dispatch failed.",
        () =>
          dispatch.then(() => {
            const turn = active.activeTurn;
            if (turn?.turnId === turnId && !turn.waiting) {
              finishTurn(threadId, active, "completed");
            }
          }),
        {
          annotations: { threadId, turnId },
          onFailure: (cause) => handlePendingTurnFailure(active, pending, cause),
        },
      );
    };

    const admitPendingTurn = (active: ActiveSession, pending: PendingTurn) => {
      active.admittingTurn = pending;
      return legacyProviderBridge
        .dispatchIfEnabled(active.providerInstanceId, "AgentController.startPendingTurn", () =>
          startAdmittedPendingTurn(active, pending),
        )
        .pipe(
          Effect.onInterrupt(() =>
            Effect.sync(() => {
              if (active.admittingTurn?.turnId !== pending.turnId) return;
              active.admittingTurn = null;
              const nextTurn = active.pendingTurns.shift();
              if (nextTurn) startPendingTurn(active, nextTurn);
            }),
          ),
        );
    };

    function startPendingTurn(active: ActiveSession, pending: PendingTurn) {
      forkPromise(
        "Akeru turn admission failed.",
        () => runPromise(admitPendingTurn(active, pending)),
        {
          annotations: { threadId: pending.threadId, turnId: pending.turnId },
          onFailure: (cause) => handlePendingTurnFailure(active, pending, cause),
        },
      );
    }

    const finishTurn = (
      threadId: ThreadId,
      active: ActiveSession,
      state: "completed" | "failed" | "interrupted",
      errorMessage?: string,
    ) => {
      const turn = active.activeTurn;
      if (!turn || turn.finished) return;
      queueTurnMemory(threadId, active, turn);
      turn.finished = true;
      completeAssistantMessages(threadId, active, turn);
      cancelAllPendingApprovals(threadId, active);
      publish({
        ...baseEvent(threadId, active, turn.turnId),
        type: "turn.completed",
        payload: {
          state,
          ...(errorMessage ? { errorMessage } : {}),
        },
      });
      resolveChildWaiter(threadId, {
        state: state === "completed" ? "completed" : "failed",
        turnId: turn.turnId,
        ...(state === "completed" && turn.assistantText.trim()
          ? { summary: turn.assistantText.trim() }
          : { error: errorMessage ?? `The delegated turn ${state}.` }),
        usage: { inputTokens: turn.inputTokens, outputTokens: turn.outputTokens },
      });
      fork(
        "Akeru worker could not record its turn outcome.",
        workerRuntime.childTurnFinished(threadId, {
          state: state === "completed" ? "completed" : "failed",
          ...(state === "completed" && turn.assistantText.trim()
            ? { summary: turn.assistantText.trim() }
            : { error: errorMessage ?? `The worker turn ${state}.` }),
        }),
        { threadId, turnId: turn.turnId },
      );
      fork(
        "Akeru workers could not settle after the parent turn.",
        workerRuntime.parentTurnEnded(threadId, turn.turnId),
        {
          threadId,
          turnId: turn.turnId,
        },
      );
      const delegationRuntime = wired().delegationRuntime;
      if (state !== "completed" && delegationRuntime) {
        forkPromise(
          "Akeru delegated work could not settle after the parent turn.",
          () =>
            delegationRuntime.parentFinished({
              threadId,
              turnId: turn.turnId,
              failed: state === "failed",
            }),
          {
            annotations: { threadId, turnId: turn.turnId },
            onFailure: (cause) => {
              publish({
                ...baseEvent(threadId, active, turn.turnId),
                type: "runtime.error",
                payload: { message: failureDetail(cause), class: "provider_error" },
              });
            },
          },
        );
      }
      for (const [requestId, request] of pendingRoutineRequests.entries()) {
        if (request.threadId !== String(threadId)) continue;
        pendingRoutineRequests.reject(
          requestId,
          new Error("The routine review ended before it received a response."),
        );
      }
      active.activeTurn = null;
      const nextTurn = active.pendingTurns.shift();
      if (nextTurn) {
        startPendingTurn(active, nextTurn);
      } else if (state === "failed") {
        // Keep the failure visible until the next turn; publishing ready here
        // would overwrite the error state that turn.completed just recorded.
        publishSessionState(threadId, active, "error", errorMessage);
      } else {
        publishSessionState(threadId, active, "ready");
      }
    };

    const publishAssistantText = (
      threadId: ThreadId,
      active: ActiveSession,
      message: MastraDBMessage,
      complete: boolean,
    ) => {
      if (message.role !== "assistant") return;
      const turn = active.activeTurn;
      if (!turn) return;
      const text = messageText(message);
      const messageKey = String(message.id);
      let activeMessage = turn.assistantMessages.get(messageKey);
      if (!activeMessage) {
        completeAssistantMessages(threadId, active, turn);
        activeMessage = {
          messageId: messageKey,
          text: "",
          publishedText: "",
          revision: 0,
        };
        turn.assistantMessages.set(messageKey, activeMessage);
      }
      activeMessage.text = text;
      if (complete) completeAssistantMessage(threadId, active, turn, activeMessage);
    };

    const handleControllerEvent = (
      threadId: ThreadId,
      active: ActiveSession,
      event: AgentControllerEvent,
    ) => {
      const turn = active.activeTurn;
      const publishToolReceipt = (
        toolCallId: string,
        toolId: string,
        phase: "start" | "progress" | "success" | "failure",
      ) => {
        const billedBotId = active.toolSession.billedBotId;
        if (!billedBotId || !turn) return;
        const createdAt = nowIso();
        publish({
          ...baseEvent(threadId, active, turn.turnId),
          type: "tool.receipt",
          payload: {
            receiptId: `${toolCallId}:${phase}`,
            toolId,
            phase,
            threadId,
            botId: billedBotId,
            billedBotId,
            fatalToThread: false,
            createdAt,
          },
        });
      };
      switch (event.type) {
        case "message_update":
          publishAssistantText(threadId, active, event.message, false);
          return;
        case "message_end":
          publishAssistantText(threadId, active, event.message, true);
          return;
        case "tool_start": {
          if (!turn) return;
          completeAssistantMessages(threadId, active, turn);
          active.toolNames.set(event.toolCallId, event.toolName);
          publishToolReceipt(event.toolCallId, event.toolName, "start");
          publish({
            ...baseEvent(threadId, active, turn.turnId),
            itemId: RuntimeItemId.make(event.toolCallId),
            type: "item.started",
            payload: {
              itemType: itemType(event.toolName),
              status: "inProgress",
              title: isCodexComputerUseTool(event.toolName) ? "Computer Use" : event.toolName,
              data: isCodexComputerUseTool(event.toolName)
                ? { action: "computer-use" }
                : { args: event.args },
            },
          });
          return;
        }
        case "tool_update":
          if (!turn) return;
          publishToolReceipt(
            event.toolCallId,
            active.toolNames.get(event.toolCallId) ?? "tool",
            "progress",
          );
          publish({
            ...baseEvent(threadId, active, turn.turnId),
            itemId: RuntimeItemId.make(event.toolCallId),
            type: "item.updated",
            payload: {
              itemType: itemType(active.toolNames.get(event.toolCallId) ?? "tool"),
              status: "inProgress",
              data: isCodexComputerUseTool(active.toolNames.get(event.toolCallId) ?? "")
                ? { action: "computer-use" }
                : { partialResult: event.partialResult },
            },
          });
          return;
        case "tool_end": {
          if (!turn) return;
          const toolName = active.toolNames.get(event.toolCallId) ?? "tool";
          const previewSnapshot =
            toolName === "preview_snapshot" && !event.isError && !event.denied
              ? persistAkeruPreviewSnapshot({
                  attachmentsDir: config.attachmentsDir,
                  threadId: String(threadId),
                  result: event.result,
                })
              : null;
          active.approvalRequests.delete(event.toolCallId);
          active.toolNames.delete(event.toolCallId);
          const mcpServerId = mcpServerIdForToolName(active.mcpServerIds, toolName);
          if (mcpServerId && !event.denied) {
            if (event.isError) {
              subscriptionAuth.recordMcpRequestFailure(mcpServerId, "The MCP tool request failed.");
            } else {
              subscriptionAuth.recordMcpRequestSuccess(mcpServerId);
            }
          }
          publishToolReceipt(
            event.toolCallId,
            toolName,
            event.isError || event.denied ? "failure" : "success",
          );
          const pending = active.pendingApprovals.get(event.toolCallId);
          if (pending) {
            cancelPendingApproval(threadId, active, event.toolCallId, pending);
            active.pendingApprovals.delete(event.toolCallId);
          }
          publish({
            ...baseEvent(threadId, active, turn.turnId),
            itemId: RuntimeItemId.make(event.toolCallId),
            type: "item.completed",
            payload: {
              itemType: itemType(toolName),
              status: event.isError ? "failed" : event.denied ? "declined" : "completed",
              title: isCodexComputerUseTool(toolName) ? "Computer Use" : toolName,
              data: isCodexComputerUseTool(toolName)
                ? { action: "computer-use" }
                : {
                    result: previewSnapshot?.activityResult ?? event.result,
                    ...(previewSnapshot?.attachment
                      ? { chatAttachment: previewSnapshot.attachment }
                      : {}),
                  },
            },
          });
          return;
        }
        case "tool_approval_required": {
          if (!turn) return;
          completeAssistantMessages(threadId, active, turn);
          active.toolNames.set(event.toolCallId, event.toolName);
          const mcpManager = sessionResources.getMcpManager(String(threadId));
          const connectorTools = mcpManager?.getTools();
          if (
            APPROVAL_FREE_MASTRA_TOOL_NAMES.has(event.toolName) &&
            (!connectorTools || !Object.hasOwn(connectorTools, event.toolName))
          ) {
            active.session.respondToToolApproval({
              toolCallId: event.toolCallId,
              decision: "approve",
            });
            return;
          }
          const toolInput = omitNullToolFields(event.args);
          const action = criticalAkeruAction(event.toolName, toolInput);
          const oneUseApproval =
            akeruActionNeedsApproval(event.toolName, toolInput) ||
            mcpToolNeedsApproval(mcpManager, event.toolName);
          if (
            event.toolName !== AKERU_PRODUCT_FEEDBACK_TOOL_NAME &&
            !oneUseApproval &&
            permissionPolicy(active.runtimeMode, akeruToolCategory(event.toolName)) === "allow"
          ) {
            forkPromise(
              "Akeru could not approve an allowed tool call.",
              () =>
                runPromise(
                  legacyProviderBridge.dispatchIfEnabled(
                    active.providerInstanceId,
                    "AgentController.handleControllerEvent",
                    () => {
                      if (active.activeTurn !== turn || turn.finished) return;
                      // Akeru runtime tools check their own grant before running.
                      const runtimeToolId =
                        AKERU_TOOL_CATALOG.find((tool) => tool.id === event.toolName)?.id ??
                        (isMemoryToolId(event.toolName) ? event.toolName : undefined);
                      if (runtimeToolId) {
                        toolRuntime.grantApproval({
                          threadId: String(threadId),
                          toolCallId: event.toolCallId,
                          toolId: runtimeToolId,
                          input: event.args,
                        });
                      }
                      active.session.respondToToolApproval({
                        toolCallId: event.toolCallId,
                        decision: "approve",
                      });
                    },
                  ),
                ),
              {
                annotations: { threadId, turnId: turn.turnId, toolCallId: event.toolCallId },
                onFailure: (cause) => {
                  if (active.activeTurn !== turn || turn.finished) return;
                  return failActiveTurn(active, threadId, turn.turnId, cause);
                },
              },
            );
            return;
          }
          // The session's own grant covers a worker chat a restart orphaned, which the
          // runtimes no longer track.
          const grant =
            wired().delegationRuntime?.accessForThread(threadId) ??
            workerRuntime.accessForThread(threadId) ??
            active.toolSession.delegation?.access;
          if (grant?.approvalCeiling === "none") {
            // Nobody can answer a prompt here, so the call fails now instead of waiting.
            active.session.respondToToolApproval({
              toolCallId: event.toolCallId,
              decision: "decline",
              declineContext: {
                reason: "approval_unavailable",
                message: `Tool '${event.toolName}' needs approval, and this chat cannot ask anyone for it. Finish without it or report the blocker.`,
              },
            });
            return;
          }
          active.approvalRequests.set(event.toolCallId, {
            name: event.toolName,
            input: toolInput,
          });
          active.pendingApprovals.set(event.toolCallId, {
            toolName: event.toolName,
            action: action ?? "unclassified",
          });
          turn.waiting = true;
          publishSessionState(threadId, active, "waiting");
          publish({
            ...baseEvent(threadId, active, turn.turnId),
            requestId: RuntimeRequestId.make(event.toolCallId),
            type: "request.opened",
            payload: {
              requestType: "dynamic_tool_call",
              actor: "agent",
              target: event.toolName,
              detail: isCodexComputerUseTool(event.toolName)
                ? "Allow Computer Use?"
                : event.toolName === AKERU_PRODUCT_FEEDBACK_TOOL_NAME
                  ? "Review product feedback"
                  : event.toolName === AKERU_CREATE_ROUTINE_TOOL_NAME
                    ? "Review routine"
                    : approvalDetail(event.toolName, action, oneUseApproval),
              toolName: isCodexComputerUseTool(event.toolName) ? "Computer Use" : event.toolName,
              ...(action ? { action } : {}),
              args: isCodexComputerUseTool(event.toolName) ? undefined : toolInput,
              options: isCodexComputerUseTool(event.toolName)
                ? [
                    { decision: "accept", label: "Allow" },
                    { decision: "decline", label: "Decline" },
                  ]
                : event.toolName === AKERU_PRODUCT_FEEDBACK_TOOL_NAME
                  ? [
                      { decision: "accept", label: "Add to feedback draft" },
                      { decision: "decline", label: "Cancel" },
                    ]
                  : event.toolName === AKERU_CREATE_ROUTINE_TOOL_NAME
                    ? [
                        { decision: "accept", label: "Create routine" },
                        { decision: "decline", label: "Cancel" },
                      ]
                    : oneUseApproval
                      ? [
                          { decision: "decline", label: "Decline" },
                          { decision: "accept", label: "Approve" },
                        ]
                      : [
                          { decision: "decline", label: "Decline" },
                          { decision: "acceptAlways", label: "Enable Auto Review" },
                          { decision: "accept", label: "Allow" },
                        ],
            },
          });
          return;
        }
        case "tool_suspended":
          if (!turn) return;
          completeAssistantMessages(threadId, active, turn);
          active.toolNames.set(event.toolCallId, event.toolName);
          turn.suspendedToolCalls.add(event.toolCallId);
          turn.waiting = true;
          publishSessionState(threadId, active, "waiting");
          const suspendPayload =
            event.suspendPayload && typeof event.suspendPayload === "object"
              ? (event.suspendPayload as Record<string, unknown>)
              : {};
          const question =
            typeof suspendPayload.question === "string" && suspendPayload.question.trim()
              ? suspendPayload.question.trim()
              : `Input required for ${event.toolName}`;
          const options = Array.isArray(suspendPayload.options)
            ? suspendPayload.options.flatMap((option) => {
                if (!option || typeof option !== "object") return [];
                const value = option as Record<string, unknown>;
                if (typeof value.label !== "string" || !value.label.trim()) return [];
                const label = value.label.trim();
                return [
                  {
                    label,
                    description:
                      typeof value.description === "string" && value.description.trim()
                        ? value.description.trim()
                        : label,
                  },
                ];
              })
            : [];
          publish({
            ...baseEvent(threadId, active, turn.turnId),
            requestId: RuntimeRequestId.make(event.toolCallId),
            type: "user-input.requested",
            payload: {
              questions: [
                {
                  id: event.toolCallId,
                  header: "Question",
                  question,
                  options,
                  multiSelect: suspendPayload.selectionMode === "multi_select",
                },
              ],
            },
          });
          return;
        case "usage_update":
          if (!turn) return;
          turn.inputTokens += Math.max(0, event.usage.promptTokens ?? 0);
          turn.outputTokens += Math.max(0, event.usage.completionTokens ?? 0);
          turn.reasoningTokens += Math.max(0, event.usage.reasoningTokens ?? 0);
          publish({
            ...baseEvent(threadId, active, turn.turnId),
            type: "thread.token-usage.updated",
            payload: {
              usage: {
                usedTokens: turn.inputTokens + turn.outputTokens,
                inputTokens: turn.inputTokens,
                outputTokens: turn.outputTokens,
                reasoningOutputTokens: turn.reasoningTokens,
              },
            },
          });
          return;
        case "error": {
          const detail = sessionFailureDetail(active, event.error);
          publish({
            ...baseEvent(threadId, active, turn?.turnId),
            type: "runtime.error",
            payload: {
              message: detail,
              class: "provider_error",
            },
          });
          finishTurn(threadId, active, "failed", detail);
          return;
        }
        case "agent_end":
          if (event.reason === "suspended") {
            if (turn) turn.waiting = true;
            publishSessionState(threadId, active, "waiting");
            return;
          }
          finishTurn(
            threadId,
            active,
            event.reason === "aborted"
              ? "interrupted"
              : event.reason === "error"
                ? "failed"
                : "completed",
          );
          return;
        default:
          return;
      }
    };

    const inspectEngine: AgentControllerShape["inspectEngine"] = Effect.fn(
      "AgentController.inspectEngine",
    )(function* (modelSelection) {
      const provider = String(modelSelection.instanceId);
      const model = modelSelection.model;
      const unavailable = (cause: unknown) =>
        new AgentControllerUnsupportedEngineError({
          provider,
          model,
          detail: `Provider instance '${provider}' is not available.`,
          cause,
        });
      const routing = yield* legacyProviderBridge
        .getInstanceInfo(modelSelection.instanceId)
        .pipe(Effect.mapError(unavailable));
      if (usesMastraCode(routing.driverKind) && !routing.enabled) {
        return yield* disabledProviderError(
          "AgentController.inspectEngine",
          modelSelection.instanceId,
        );
      }
      // Fail closed on a model the instance's snapshot does not advertise.
      // The bot engine is applied after ws-level preflight ran against the
      // command's own selection, so this check is the only validation a
      // bot-owned thread ever sees. An empty snapshot is not evidence the
      // model is unknown — the first probe may still be running.
      // Only a settled probe is authoritative: pending snapshots still carry
      // the built-in catalog, and probe fallbacks do too, so neither proves the
      // saved model is gone.
      if (
        usesMastraCode(routing.driverKind) &&
        routing.instanceSnapshot !== undefined &&
        routing.instanceSnapshot.status === "ready"
      ) {
        const advertised = routing.instanceSnapshot.models;
        if (advertised.length > 0 && !advertised.some((entry) => entry.slug === model)) {
          const name = routing.instanceSnapshot.displayName ?? routing.driverKind;
          return yield* new AgentControllerUnsupportedEngineError({
            provider,
            model,
            detail: `Model '${model}' is not available for ${name}.`,
          });
        }
      }
      if (routing.mastraConnection) {
        modelConnections.set(String(modelSelection.instanceId), routing.mastraConnection);
      } else {
        modelConnections.delete(String(modelSelection.instanceId));
      }
      if (usesMastraCode(routing.driverKind)) {
        const subscriptionProvider = subscriptionProviderForDriver(routing.driverKind);
        const issue = mastraConnectionIssue(
          routing.driverKind,
          routing.mastraConnection,
          subscriptionProvider
            ? subscriptionAuth.isConnected(subscriptionProvider, modelSelection.instanceId)
            : false,
        );
        if (issue) return yield* unavailable(new Error(issue));
      }
      const capabilities = usesMastraCode(routing.driverKind)
        ? { sessionModelSwitch: "in-session" as const }
        : yield* legacyProviderBridge
            .getCapabilities(modelSelection.instanceId)
            .pipe(Effect.mapError(unavailable));
      return { modelSelection, routing, capabilities };
    });

    const resolveEngine: AgentControllerShape["resolveEngine"] = (input) =>
      mutationLock.withPermits(1)(
        Effect.gen(function* () {
          const modelSelection =
            input.engine === null
              ? input.fallback
              : {
                  instanceId: ProviderInstanceId.make(input.engine.provider),
                  model: input.engine.model,
                  ...(input.engine.options ? { options: input.engine.options } : {}),
                };
          const inspected = yield* inspectEngine(modelSelection);
          const previous = resolvedByThread.get(String(input.threadId));
          const resolved: ResolvedEngine = {
            modelSelection,
            provider: inspected.routing.driverKind,
            providerInstanceId: modelSelection.instanceId,
            mastraModelId: mastraModelId(inspected.routing.driverKind, modelSelection.model),
            mode: input.mode,
            botConversation: input.botConversation,
            ...(previous?.botName ? { botName: previous.botName } : {}),
            ...(previous?.personalityTone !== undefined
              ? { personalityTone: previous.personalityTone }
              : {}),
          };
          resolvedByThread.set(String(input.threadId), resolved);
          const active = sessions.get(String(input.threadId));
          if (active && usesMastraCode(resolved.provider)) {
            const { modelOptions: _priorModelOptions, ...activeState } = active.session.state.get();
            const nextModelOptions = mastraModelOptions(resolved);
            yield* runMastra("state.set", () =>
              active.session.state.set({
                ...activeState,
                providerInstanceId: String(resolved.providerInstanceId),
                ...(nextModelOptions ? { modelOptions: nextModelOptions } : {}),
              }),
            );
            yield* runMastra("model.switch", () =>
              active.session.model.switch({ modelId: resolved.mastraModelId }),
            );
            const nextMode = mastraModeId(input.mode);
            if (active.session.mode.get() !== nextMode) {
              yield* runMastra("mode.switch", () =>
                active.session.mode.switch({ modeId: nextMode }),
              );
            }
            active.model = modelSelection.model;
          }
          return { ...inspected, mode: input.mode };
        }),
      );

    const isOpenDelegation = (delegation: AkeruDelegationRecord) =>
      !["Completed", "Failed", "Canceled"].includes(delegation.phase._tag);
    const isChildOf = (delegation: AkeruDelegationRecord, threadId: ThreadId) =>
      delegation.phase._tag !== "Queued" && delegation.phase.childThreadId === threadId;

    // Resolves the thread's bot, group boss, and delegation links with by-id
    // reads. Falls back to the command read model for query doubles that do
    // not implement the narrow lookups.
    const readSessionStartContext = Effect.fn("AgentController.readSessionStartContext")(function* (
      threadId: ThreadId,
      fallbackBotId: BotId | null,
    ) {
      if (Option.isNone(projectionSnapshotQuery)) {
        return {
          parentDelegation: undefined,
          bot: undefined,
          botId: fallbackBotId,
          activeChildDelegations: 0,
          threadTitle: undefined,
        };
      }
      const query = projectionSnapshotQuery.value;
      const { getBotById, getGroupById, listThreadDelegations } = query;
      if (getBotById && getGroupById && listThreadDelegations) {
        const thread = Option.getOrUndefined(yield* query.getThreadRuntimeContext(threadId));
        const delegations = (yield* listThreadDelegations(threadId)).filter(isOpenDelegation);
        const group = thread?.groupId
          ? Option.getOrUndefined(yield* getGroupById(thread.groupId))
          : undefined;
        const botId =
          thread?.respondingBotId ?? thread?.botId ?? fallbackBotId ?? group?.bossBotId ?? null;
        const bot = botId ? Option.getOrUndefined(yield* getBotById(botId)) : undefined;
        const workerParentThreadId = isWorkerThreadId(threadId) ? thread?.parentThreadId : null;
        return {
          parentDelegation: delegations.find((candidate) => isChildOf(candidate, threadId)),
          workerParent: workerParentThreadId
            ? {
                delegatedAccess: (yield* listThreadDelegations(workerParentThreadId)).find(
                  (candidate) => isChildOf(candidate, workerParentThreadId),
                )?.access,
              }
            : undefined,
          bot,
          botId,
          activeChildDelegations: delegations.filter(
            (candidate) => candidate.parentThreadId === threadId,
          ).length,
          threadTitle: thread?.title,
        };
      }
      const snapshot = yield* query.getCommandReadModel();
      const thread = snapshot.threads.find((candidate) => candidate.id === threadId);
      const group = thread?.groupId
        ? snapshot.groups.find((candidate) => candidate.id === thread.groupId)
        : undefined;
      const botId =
        thread?.respondingBotId ?? thread?.botId ?? fallbackBotId ?? group?.bossBotId ?? null;
      const workerParentThreadId = isWorkerThreadId(threadId) ? thread?.parentThreadId : null;
      return {
        parentDelegation: snapshot.delegations.find(
          (candidate) => isChildOf(candidate, threadId) && isOpenDelegation(candidate),
        ),
        workerParent: workerParentThreadId
          ? {
              delegatedAccess: snapshot.delegations.find((candidate) =>
                isChildOf(candidate, workerParentThreadId),
              )?.access,
            }
          : undefined,
        bot: snapshot.bots.find((candidate) => candidate.id === botId),
        botId,
        activeChildDelegations: snapshot.delegations.filter(
          (candidate) => candidate.parentThreadId === threadId && isOpenDelegation(candidate),
        ).length,
        threadTitle: thread?.title,
      };
    });

    const startSession: AgentControllerShape["startSession"] = Effect.fn(
      "AgentController.startSession",
    )(function* (threadId, input) {
      const key = String(threadId);
      const { parentDelegation, workerParent, bot, botId, activeChildDelegations, threadTitle } =
        yield* readSessionStartContext(threadId, input.botId ?? null);
      const isWorkerThread = workerRuntime.depthForThread(threadId) > 0;
      const botAccess: AkeruDelegationAccessGrant = {
        allowedToolIds: AKERU_TOOL_CATALOG.map((tool) => tool.id),
        memoryScopes: ["private", "bot", "project", "group", "workspace"],
        sandbox: input.botSandbox ?? null,
        runtimeMode: input.runtimeMode,
        hasUserComputer: Boolean(input.cwd),
        enabledMcpServerIds: (input.mcpServers ?? [])
          .map((server) => server.id)
          .filter((serverId) => !bot?.disabledMcpServerIds.includes(serverId)),
        disabledMcpServerIds: bot?.disabledMcpServerIds ?? [],
        approvalCeiling: "secrets",
      };
      // A restart drops the worker runtime's grants, so a worker chat it orphaned rebuilds
      // its grant from the parent chat: the parent's delegated grant, or the bot's own for a
      // top-level parent. Without a parent link it keeps no tools rather than gaining any.
      const orphanedWorkerAccess = () =>
        workerAccess(
          workerParent
            ? (workerParent.delegatedAccess ?? {
                ...botAccess,
                sandbox: botAccess.sandbox ?? "local",
              })
            : { ...botAccess, allowedToolIds: [], enabledMcpServerIds: [] },
        );
      const delegatedAccess =
        wired().delegationRuntime?.accessForThread(threadId) ??
        parentDelegation?.access ??
        workerRuntime.accessForThread(threadId) ??
        (isWorkerThread ? orphanedWorkerAccess() : undefined);
      const access = delegatedAccess ?? botAccess;
      // A top-level bot's null sandbox is its local workspace, while a delegated
      // null sandbox has none, so workers receive the local workspace explicitly.
      const workerParentAccess: AkeruDelegationAccessGrant =
        delegatedAccess || access.sandbox !== null ? access : { ...access, sandbox: "local" };
      const mcpServers = (input.mcpServers ?? []).filter(
        (server) =>
          access.enabledMcpServerIds.includes(server.id) &&
          !access.disabledMcpServerIds.includes(server.id),
      );
      const workspaceType =
        delegatedAccess && access.sandbox === null
          ? "none"
          : access.sandbox === null || access.sandbox === "local"
            ? "local"
            : "cloud";
      const resourceScope = botRuntimeResourceScope({
        sharing: input.botSandboxBrowserSharing ?? DEFAULT_BOT_SANDBOX_BROWSER_SHARING,
        ...(botId ? { botId } : {}),
        threadId: key,
      });
      const workspaceResourceKey = botWorkspaceResourceKey({
        resourceScope,
        sandbox: access.sandbox,
        ...(access.sandbox !== null && access.sandbox !== "local" && input.botSandboxEnvironment
          ? {
              credentialFingerprint: botWorkspaceCredentialFingerprint(input.botSandboxEnvironment),
            }
          : {}),
      });
      const workspaceId = botWorkspaceIdentity(workspaceResourceKey);
      const existing = sessions.get(key);
      const resolved = resolvedByThread.get(key);
      if (!resolved) {
        return yield* new AgentControllerRuntimeError({
          operation: "startSession",
          detail: `Thread '${threadId}' has no resolved engine.`,
        });
      }
      const personalityTone =
        input.personalityTone ?? bot?.personalityTone ?? BALANCED_BOT_PERSONALITY_TONE;
      resolvedByThread.set(key, {
        ...resolved,
        ...(input.botName ? { botName: input.botName } : {}),
        personalityTone,
      });
      if (usesMastraCode(resolved.provider)) {
        const routing = yield* legacyProviderBridge.getInstanceInfo(resolved.providerInstanceId);
        if (!routing.enabled) {
          return yield* disabledProviderError(
            "AgentController.startSession",
            resolved.providerInstanceId,
          );
        }
      }
      if (
        mcpServers.some((server) => isCodexComputerUseServer(String(server.id))) &&
        resolved.provider !== ProviderDriverKind.make("codex")
      ) {
        return yield* new AgentControllerRuntimeError({
          operation: "startSession",
          detail: "Computer Use requires a Codex bot.",
        });
      }
      const migrationBotId = input.memoryAccess?.respondingBotId ?? input.memoryAccess?.botId;
      if (migrationBotId && input.memoryAccess && options?.entityMemoryRepository) {
        const migrationKeys = legacyMemoryMigrationKeys(input.memoryAccess);
        const migrationsComplete = yield* Effect.promise(() =>
          Promise.all(
            migrationKeys.map((migrationKey) =>
              botMemoryStore.isMigrationComplete(migrationBotId, migrationKey),
            ),
          ),
        );
        if (migrationsComplete.some((complete) => !complete)) {
          const revisions = yield* Effect.forEach(
            legacyMemoryMigrationAccesses(input.memoryAccess),
            (access) => options.entityMemoryRepository!.listCurrent({ access }),
          ).pipe(
            Effect.map((sets) => [
              ...new Map(sets.flat().map((revision) => [revision.id, revision])).values(),
            ]),
            Effect.mapError(
              (cause) =>
                new AgentControllerRuntimeError({
                  operation: "memory.migrate.read",
                  detail: failureDetail(cause),
                  cause,
                }),
            ),
          );
          yield* runMastra("memory.migrate", () =>
            migrateLegacyBotMemory({
              store: botMemoryStore,
              access: input.memoryAccess!,
              revisions,
            }),
          );
        }
      }
      // A cwd change invalidates reuse for local workspaces: the user-computer
      // workspace lease is keyed by cwd and the session tools would keep
      // acting on the old directory. Remote sandboxes have no user-computer
      // workspace, so cwd only feeds projectPath there and can update in place.
      if (
        existing?.workspaceResourceKey === workspaceResourceKey &&
        (existing.cwd === input.cwd || isRemoteBotSandbox(access.sandbox)) &&
        existing.toolSession.workspaceType === workspaceType &&
        sameMcpServerConfigurations(existing.mcpServers, mcpServers) &&
        resolved &&
        existing.provider === resolved.provider &&
        existing.providerInstanceId === resolved.providerInstanceId
      ) {
        existing.runtimeMode = access.runtimeMode;
        existing.cwd = input.cwd;
        yield* runMastra("state.set", () =>
          existing.session.state.set({
            projectPath: input.cwd || undefined,
            yolo: false,
            botConversation: resolved.botConversation,
            botName: input.botName || "",
            personalityTone,
            mcpInstructions: formatMcpServerInstructions(mcpServers),
          }),
        );
        const toolSession = { ...existing.configuredToolSession };
        delete toolSession.botId;
        delete toolSession.botName;
        delete toolSession.billedBotId;
        delete toolSession.delegation;
        delete toolSession.workers;
        delete toolSession.memoryHandlers;
        delete toolSession.botState;
        delete toolSession.imageGeneration;
        const imageGeneration = yield* imageToolSettings;
        const settings = yield* memorySettings();
        const nextMemoryHandlers =
          access.memoryScopes.length > 0
            ? memoryHandlers(input.memoryAccess, access.memoryScopes)
            : undefined;
        const configuredToolSession: AkeruToolSession = {
          ...toolSession,
          runtimeMode: access.runtimeMode,
          ...(botId ? { botId } : {}),
          ...(input.botName ? { botName: input.botName } : {}),
          ...(nextMemoryHandlers ? { memoryHandlers: nextMemoryHandlers } : {}),
          ...(delegatedAccess && botId ? { billedBotId: botId } : {}),
          ...(wired().delegationRuntime && botId
            ? {
                delegation: delegationFor({
                  threadId,
                  botId,
                  parentDelegation,
                  access,
                  activeChildDelegations,
                }),
              }
            : {}),
          ...(wired().workerOrchestration && botId && !isWorkerThread
            ? { workers: workersFor(threadId, workerParentAccess) }
            : {}),
          ...(input.botId && wired().botStateRuntime ? { botState: wired().botStateRuntime } : {}),
          imageGeneration,
        };
        existing.configuredToolSession = configuredToolSession;
        existing.startInput = input;
        existing.configuredMemoryAccess = delegatedAccess
          ? undefined
          : memoryAccessFor(input.memoryAccess);
        existing.configuredEntityMemoryAccess = input.memoryAccess;
        existing.privateBotMemory = settings.privateBotMemory;
        if (!existing.activeTurn && !existing.admittingTurn && existing.pendingTurns.length === 0) {
          existing.toolSession = configuredToolSession;
          existing.memoryAccess = existing.configuredMemoryAccess;
          existing.entityMemoryAccess = existing.configuredEntityMemoryAccess;
          toolRuntime.registerSession(key, existing.toolSession);
        }
        return toProviderSession(threadId, existing);
      }
      const existingLegacy = legacyResourceIdentity.get(key);
      const settings = yield* memorySettings();
      const nextMemoryAccess = delegatedAccess ? undefined : memoryAccessFor(input.memoryAccess);
      const nextMemoryHandlers =
        access.memoryScopes.length > 0
          ? memoryHandlers(input.memoryAccess, access.memoryScopes)
          : undefined;
      if (
        !existing &&
        resolved &&
        existingLegacy?.workspaceResourceKey === workspaceResourceKey &&
        existingLegacy.cwd === input.cwd &&
        existingLegacy.provider === resolved.provider &&
        existingLegacy.providerInstanceId === resolved.providerInstanceId &&
        existingLegacy.botName === input.botName &&
        existingLegacy.personalityTone === personalityTone &&
        existingLegacy.memoryAccessKey === memoryAccessKey(nextMemoryAccess)
      ) {
        const live = (yield* legacyProviderBridge.listSessions()).find(
          (session) => session.threadId === threadId,
        );
        if (live) {
          existingLegacy.memoryAccess = nextMemoryAccess;
          existingLegacy.entityMemoryAccess = input.memoryAccess;
          existingLegacy.privateBotMemory = settings.privateBotMemory;
          if (nextMemoryHandlers?.memory) {
            McpMemoryToolSession.setMcpMemoryToolSession(threadId, nextMemoryHandlers.memory);
          } else {
            McpMemoryToolSession.clearMcpMemoryToolSession(threadId);
          }
          return live;
        }
        yield* runMastra("resources.release", () => sessionResources.release(key)).pipe(
          Effect.ignoreCause({ log: true }),
        );
        legacyResourceIdentity.delete(key);
      }
      if (existing || existingLegacy) {
        const previousWorkspaceResourceKey =
          existing?.workspaceResourceKey ?? existingLegacy?.workspaceResourceKey;
        yield* stopSessionWithResources(
          { threadId },
          previousWorkspaceResourceKey !== workspaceResourceKey,
        );
      }
      if (delegatedAccess && !usesMastraCode(resolved.provider)) {
        return yield* new AgentControllerRuntimeError({
          operation: "startSession",
          detail: `Provider '${resolved.provider}' cannot enforce delegated access.`,
        });
      }
      if (!(delegatedAccess && access.sandbox === null)) {
        yield* preparePreviewMcpSession(
          threadId,
          resolved.providerInstanceId,
          usesMastraCode(resolved.provider) ? undefined : nextMemoryHandlers?.memory,
        );
      }
      const resources =
        delegatedAccess && access.sandbox === null
          ? ({ workspaceType: "none" } as const)
          : yield* runMastra("resources.acquire", () =>
              sessionResources.acquire({
                threadId: key,
                resourceScope,
                workspaceResourceKey,
                workspaceId,
                ...(access.sandbox !== null ? { botSandbox: access.sandbox } : {}),
                ...(access.sandbox !== null &&
                access.sandbox !== "local" &&
                input.botSandboxEnvironment
                  ? { sandboxEnvironment: input.botSandboxEnvironment }
                  : {}),
                ...((!delegatedAccess || access.hasUserComputer) && input.cwd
                  ? { userComputerCwd: input.cwd }
                  : {}),
                mcpServers,
                exclusiveComputer: resolved.provider === "codex" || resolved.provider === "kimi",
                ...(botId ? { botId } : {}),
                ...(bot?.name ? { botName: bot.name } : {}),
                taskOrRoutine: threadTitle ?? "Browser task",
              }),
            ).pipe(Effect.onError(() => clearPreviewMcpSession(threadId)));
      if (!usesMastraCode(resolved.provider)) {
        const frozenMemoryContext =
          nextMemoryAccess && settings.enabled
            ? formatBotMemoryPrompt(
                yield* Effect.promise(() =>
                  settings.privateBotMemory
                    ? botMemoryStore.readPromptSnapshot(nextMemoryAccess)
                    : botMemoryStore.readPromptSnapshot(nextMemoryAccess).then((snapshot) => ({
                        ...snapshot,
                        memory: { ...snapshot.memory, content: "", charCount: 0 },
                      })),
                ),
              )
            : "";
        const entityPacket =
          nextMemoryAccess && settings.enabled
            ? yield* runMastra("memory.packet", () => entityMemoryContext(input.memoryAccess))
            : "";
        const combinedMemoryContext = [frozenMemoryContext, entityPacket]
          .filter(Boolean)
          .join("\n\n");
        return yield* legacyProviderBridge
          .startSession(threadId, {
            ...input,
            personalityTone,
            ...(combinedMemoryContext ? { persistentMemoryContext: combinedMemoryContext } : {}),
          })
          .pipe(
            Effect.tap((session) =>
              Effect.sync(() => {
                legacyResourceIdentity.set(key, {
                  workspaceResourceKey,
                  cwd: input.cwd,
                  provider: resolved.provider,
                  providerInstanceId: resolved.providerInstanceId,
                  botName: input.botName,
                  personalityTone,
                  memoryAccess: nextMemoryAccess,
                  entityMemoryAccess: input.memoryAccess,
                  memoryAccessKey: memoryAccessKey(nextMemoryAccess),
                  privateBotMemory: settings.privateBotMemory,
                });
                return session;
              }),
            ),
            Effect.tapError(() =>
              runMastra("resources.release", () =>
                sessionResources.release(key, { destroy: true }),
              ).pipe(Effect.ignoreCause({ log: true })),
            ),
          );
      }
      const workspace = "botWorkspace" in resources ? resources.botWorkspace : undefined;
      const userComputerWorkspace =
        "workspace" in resources && access.hasUserComputer && workspaceType === "local" && input.cwd
          ? resources.workspace
          : undefined;
      const registeredMemoryHandlers = nextMemoryHandlers;
      const mcpManager = sessionResources.getMcpManager(key);
      const imageGenerationSettings = yield* imageToolSettings;
      const mcpDependencies =
        input.botId && input.botName
          ? { dependentBots: [{ id: input.botId, name: input.botName }], dependentRoutines: [] }
          : { dependentBots: [], dependentRoutines: [] };
      const toolSession: AkeruToolSession = {
        ...(botId ? { botId } : {}),
        ...(input.botName ? { botName: input.botName } : {}),
        runtimeMode: access.runtimeMode,
        workspaceType,
        ...(workspace ? { workspace } : {}),
        ...(userComputerWorkspace ? { userComputerWorkspace } : {}),
        ...(registeredMemoryHandlers ? { memoryHandlers: registeredMemoryHandlers } : {}),
        ...(input.botId && wired().botStateRuntime ? { botState: wired().botStateRuntime } : {}),
        imageGeneration: imageGenerationSettings,
        catalogHandlers: createAkeruCatalogToolHandlers(
          mcpManager,
          wired().pluginRuntime,
          mcpManager
            ? {
                getRequestHealth: (serverId) => subscriptionAuth.mcpRequestHealth(serverId),
                recordSuccess: (serverId, at) =>
                  subscriptionAuth.recordMcpRequestSuccess(serverId, at),
                recordFailure: (serverId, message, at) =>
                  subscriptionAuth.recordMcpRequestFailure(serverId, message, at),
                getDependencies: async (serverId) => {
                  const snapshot = await wired().pluginRuntimeOptions?.readSnapshot();
                  return snapshot
                    ? {
                        dependentBots: mcpServerDependentBots(snapshot, serverId),
                        dependentRoutines: [],
                      }
                    : mcpDependencies;
                },
                onFailure: (serverId, message, dependencies) => {
                  for (const bot of dependencies.dependentBots) {
                    botInbox.ensureOpen({
                      incidentKey: `access:mcp-${serverId}:${bot.id}`,
                      kind: "connector-failure",
                      botId: bot.id,
                      botName: bot.name,
                      taskOrRoutine: `${serverId} access`,
                      lastFailure: message,
                      nextAction: `Reconnect ${serverId}, then retry its failed request.`,
                    });
                  }
                },
                onRecovery: (serverId, dependencies) => {
                  for (const bot of dependencies.dependentBots) {
                    botInbox.resolve(`access:mcp-${serverId}:${bot.id}`);
                  }
                },
              }
            : undefined,
          {
            webSearch: akeruWebSearchUnavailable,
            webFetch,
            // The router bounds each provider attempt and interruptTurn cancels
            // in-flight requests, so there is no outer deadline here.
            generateImage: async (request: unknown) => {
              const generate = options?.generateImage ?? runImageGenerationTool;
              return runPromise(generate(threadId, request));
            },
            ...(wired().pluginRuntimeOptions
              ? {
                  addMcpServer: async (input: unknown) => {
                    const value = decodeAkeruToolInput("AddMcpServer", input);
                    const base = {
                      type: "mcp-server.create" as const,
                      commandId: CommandId.make(`catalog:mcp-add:${NodeCrypto.randomUUID()}`),
                      mcpServerId: value.serverId,
                      name: value.name,
                      enabled: true,
                      createdAt: nowIso(),
                    };
                    await wired().pluginRuntimeOptions!.dispatch(
                      value.transport === "stdio"
                        ? {
                            ...base,
                            transport: "stdio",
                            command: value.command,
                            ...(value.args ? { args: [...value.args] } : {}),
                          }
                        : { ...base, transport: "url", url: value.url },
                    );
                    return { serverId: value.serverId, added: true };
                  },
                  uninstallMcpServer: (serverId: string) =>
                    deleteCatalogMcpServer(wired().pluginRuntimeOptions!, serverId, "mcp-delete"),
                  removeMcpAccount: (serverId: string) =>
                    deleteCatalogMcpServer(wired().pluginRuntimeOptions!, serverId, "mcp-remove"),
                  renameMcpAccount: async (input: unknown) => {
                    const value = decodeAkeruToolInput("RenameMcpAccount", input);
                    const server = (
                      await wired().pluginRuntimeOptions!.readSnapshot()
                    ).mcpServers?.find((candidate) => candidate.id === value.serverId);
                    if (!server) throw new Error(`MCP server '${value.serverId}' was not found.`);
                    const base = {
                      type: "mcp-server.update" as const,
                      commandId: CommandId.make(`catalog:mcp-rename:${NodeCrypto.randomUUID()}`),
                      mcpServerId: server.id,
                      name: value.name,
                    };
                    await wired().pluginRuntimeOptions!.dispatch(
                      server.transport === "stdio"
                        ? {
                            ...base,
                            transport: "stdio",
                            command: server.command,
                            ...(server.args ? { args: [...server.args] } : {}),
                          }
                        : { ...base, transport: "url", url: server.url },
                    );
                    return { serverId: value.serverId, name: value.name, renamed: true };
                  },
                  setMcpInstructions: async (value: {
                    readonly serverId: string;
                    readonly instructions: string;
                  }) => {
                    await wired().pluginRuntimeOptions!.dispatch({
                      type: "mcp-server.instructions.set",
                      commandId: CommandId.make(
                        `catalog:mcp-instructions:${NodeCrypto.randomUUID()}`,
                      ),
                      mcpServerId: McpServerId.make(value.serverId),
                      instructions: value.instructions,
                    });
                    return {
                      serverId: value.serverId,
                      instructions: value.instructions.trim(),
                      appliesFrom: "next-turn",
                    };
                  },
                }
              : {}),
          },
        ),
        ...(delegatedAccess && botId ? { billedBotId: botId } : {}),
        ...(wired().delegationRuntime && botId
          ? {
              sendToUser: async (request) => {
                const active = sessions.get(key);
                const turnId = active?.activeTurn?.turnId;
                if (!turnId) throw new Error("User messaging requires an active turn.");
                return wired().delegationRuntime!.sendToUser(
                  {
                    threadId,
                    turnId,
                    botId,
                    parentDelegationId: parentDelegation?.delegationId ?? null,
                    ancestorBotIds: parentDelegation?.ancestorBotIds ?? [],
                    depth: parentDelegation?.depth ?? 0,
                    access,
                  },
                  request,
                );
              },
              delegation: delegationFor({
                threadId,
                botId,
                parentDelegation,
                access,
                activeChildDelegations,
              }),
            }
          : {}),
        ...(wired().workerOrchestration && botId && !isWorkerThread
          ? { workers: workersFor(threadId, workerParentAccess) }
          : {}),
        ...(input.botId && wired().channelRuntime
          ? {
              reactToMessage: (request, toolCallId) =>
                wired().channelRuntime!.react(threadId, input.botId!, request, toolCallId),
              channels: {
                create: (request) => wired().channelRuntime!.create(input.botId!, request),
                update: (request) => wired().channelRuntime!.update(input.botId!, request),
              },
            }
          : {}),
      };
      toolRuntime.registerSession(key, toolSession);
      const session = yield* runMastra("createSession", () =>
        bundle.controller.createSession({
          id: key,
          ownerId: "akeru-desktop",
          resourceId: key,
          threadId: key,
          ...(input.cwd ? { tags: { projectPath: input.cwd } } : {}),
          ...(workspace ? { workspace } : {}),
        }),
      ).pipe(
        Effect.tapError(() =>
          Effect.all(
            [
              runMastra("resources.release", () =>
                sessionResources.release(key, { destroy: true }),
              ).pipe(Effect.ignoreCause({ log: true })),
              Effect.sync(() => toolRuntime.unregisterSession(key)),
            ],
            { discard: true },
          ),
        ),
      );
      const cleanupCreatedSession = Effect.gen(function* () {
        yield* runMastra("deleteSession", () =>
          bundle.controller.deleteSession({ resourceId: key }),
        ).pipe(Effect.ignoreCause({ log: true }));
        yield* runMastra("resources.release", () =>
          sessionResources.release(key, { destroy: true }),
        ).pipe(Effect.ignoreCause({ log: true }));
        toolRuntime.unregisterSession(key);
      });
      const active = yield* Effect.gen(function* () {
        const modelOptions = mastraModelOptions(resolved);
        yield* runMastra("state.set", () =>
          session.state.set({
            providerInstanceId: String(resolved.providerInstanceId),
            ...(input.cwd ? { projectPath: input.cwd } : {}),
            yolo: false,
            botConversation: resolved.botConversation,
            ...(input.botName ? { botName: input.botName } : {}),
            personalityTone,
            mcpInstructions: formatMcpServerInstructions(mcpServers),
            ...(modelOptions ? { modelOptions } : {}),
          }),
        );
        yield* runMastra("model.switch", () =>
          session.model.switch({ modelId: resolved.mastraModelId }),
        );
        const modeId = mastraModeId(resolved.mode);
        if (session.mode.get() !== modeId) {
          yield* runMastra("mode.switch", () => session.mode.switch({ modeId }));
        }
        yield* Effect.forEach(
          ["read", "edit", "execute", "mcp", "other"] as const,
          (category) =>
            runMastra("permissions.setForCategory", () =>
              session.permissions.setForCategory({
                category,
                policy: permissionPolicy(access.runtimeMode, category),
              }),
            ),
          { discard: true },
        );
        yield* Effect.forEach(
          new Set([
            ...toolRuntime.toolsForThread(key).map((tool) => tool.id),
            ...Object.keys(sessionResources.getConnectorTools(key)),
            AKERU_PRODUCT_FEEDBACK_TOOL_NAME,
            "RestartMcpServers",
          ]),
          (toolName) =>
            runMastra("permissions.setForTool", () =>
              session.permissions.setForTool({ toolName, policy: "ask" }),
            ),
          { discard: true },
        );
        const unsubscribe = session.subscribe((event) => {
          const current = sessions.get(key);
          if (current) handleControllerEvent(threadId, current, event);
        });
        return {
          session,
          startInput: input,
          pendingDispatches: new Set<Promise<void>>(),
          provider: resolved.provider,
          providerInstanceId: resolved.providerInstanceId,
          cwd: input.cwd,
          createdAt: nowIso(),
          mcpServerIds: mcpServers.map((server) => server.id),
          mcpServers,
          runtimeMode: access.runtimeMode,
          model: resolved.modelSelection.model,
          status: "ready" as const,
          turnAdmissionGeneration: 0,
          activeTurn: null,
          admittingTurn: null,
          pendingTurns: [],
          toolNames: new Map<string, string>(),
          approvalRequests: new Map(),
          connectorSessionApprovals: new Set<string>(),
          toolSession,
          memoryAccess: nextMemoryAccess,
          entityMemoryAccess: input.memoryAccess,
          configuredToolSession: toolSession,
          configuredMemoryAccess: nextMemoryAccess,
          configuredEntityMemoryAccess: input.memoryAccess,
          privateBotMemory: settings.privateBotMemory,
          workspaceResourceKey,
          pendingApprovals: new Map<string, PendingApproval>(),
          unsubscribe,
        } satisfies ActiveSession;
      }).pipe(Effect.onError(() => cleanupCreatedSession));
      sessions.set(key, active);
      publish({
        ...baseEvent(threadId, active),
        type: "session.started",
        payload: { message: "Mastra Code session ready" },
      });
      publishSessionState(threadId, active, "ready");
      return toProviderSession(threadId, active);
    });

    const sendTurn: AgentControllerShape["sendTurn"] = Effect.fn("AgentController.sendTurn")(
      function* (input) {
        const key = String(input.threadId);
        const resolved = resolvedByThread.get(key);
        if (resolved && usesMastraCode(resolved.provider)) {
          const routing = yield* legacyProviderBridge.getInstanceInfo(resolved.providerInstanceId);
          if (!routing.enabled) {
            return yield* disabledProviderError(
              "AgentController.sendTurn",
              resolved.providerInstanceId,
            );
          }
        }
        const active = sessions.get(key);
        if (!active) {
          if (
            usesMastraCode(resolvedByThread.get(key)?.provider ?? ProviderDriverKind.make("codex"))
          ) {
            return yield* new AgentControllerRuntimeError({
              operation: "sendTurn",
              detail: `Mastra session for thread '${input.threadId}' is not running.`,
            });
          }
          const { botUsage: _, delegationResults, ...providerInput } = input;
          // memory.enabled is authoritative per turn: while it is off the turn
          // must not read the durable snapshot or reserve review cadence. The
          // identity keeps its stored access so re-enabling restores memory.
          const settings = yield* memorySettings();
          const memoryAccess = settings.enabled
            ? legacyResourceIdentity.get(key)?.memoryAccess
            : undefined;
          const entityMemoryAccess = settings.enabled
            ? yield* runMastra("memory.access", () =>
                refreshEntityMemoryAccess(legacyResourceIdentity.get(key)?.entityMemoryAccess),
              )
            : undefined;
          if (
            settings.enabled &&
            legacyResourceIdentity.get(key)?.entityMemoryAccess &&
            !entityMemoryAccess
          ) {
            return yield* new AgentControllerRuntimeError({
              operation: "sendTurn.memory",
              detail: "The bot is no longer a member of this group.",
            });
          }
          const entityPacket = entityMemoryAccess
            ? yield* runMastra("memory.packet", () => entityMemoryContext(entityMemoryAccess))
            : "";
          const conversation = bundle.readObservationalMemory
            ? yield* runMastra("memory.read", () => bundle.readObservationalMemory!(key, key))
            : undefined;
          const observationContext = conversation?.current?.activeObservations
            ? [
                "<thread-observations>",
                conversation.current.activeObservations,
                "</thread-observations>",
              ].join("\n")
            : "";
          const memoryTurn = memoryAccess
            ? yield* Effect.promise(() =>
                memoryTurnHarness.admit({
                  access: memoryAccess,
                  input: {
                    threadId: key,
                    groupId: memoryAccess.groupId === null ? null : String(memoryAccess.groupId),
                    text: (providerInput.input ?? "").slice(0, 4_000),
                  },
                  privateBotMemory: settings.privateBotMemory,
                }),
              )
            : undefined;
          const pendingMemory: LegacyTurnMemoryState = {
            observationPromptId: NodeCrypto.randomUUID(),
            observationRecorded: false,
            seenEventIds: new Set(),
            user: providerInput.input ?? "",
            modelId: resolved?.mastraModelId ?? "openai/gpt-5.6-sol",
            turnId: undefined,
            dispatchReturned: false,
            earlyEvents: [],
            assistant: "",
            memoryTurn,
            hiddenWake: input.hiddenWake === true,
          };
          if (memoryTurn?.reviewIncluded) {
            const priorMemoryHandler = McpMemoryToolSession.readMcpMemoryToolSession(
              input.threadId,
            );
            if (priorMemoryHandler) {
              const reviewMemoryHandler = memoryTurn.wrapMemoryHandler(priorMemoryHandler);
              pendingMemory.priorMemoryHandler = priorMemoryHandler;
              pendingMemory.reviewMemoryHandler = reviewMemoryHandler;
              McpMemoryToolSession.setMcpMemoryToolSession(input.threadId, reviewMemoryHandler);
            }
          }
          addLegacyPending(key, pendingMemory);
          const turnInstructions = resolved?.botConversation
            ? createAkeruBotTurnInstructions({
                ...(resolved.botName ? { name: resolved.botName } : {}),
                ...(resolved.personalityTone !== undefined
                  ? { personalityTone: resolved.personalityTone }
                  : {}),
              })
            : "";
          // OpenCode reads per-turn context as its system prompt. Claude and Grok
          // only read context at session start, so this turn's text carries it.
          const contextInSystem = resolved?.provider === "opencode";
          const providerContext = [
            contextInSystem ? turnInstructions : "",
            memoryTurn?.context,
            entityPacket,
            observationContext,
            contextInSystem ? delegationResults : "",
          ]
            .filter(Boolean)
            .join("\n\n");
          const inputPrefix = contextInSystem ? [] : [turnInstructions, delegationResults];
          return yield* legacyProviderBridge
            .sendTurn({
              ...providerInput,
              ...(inputPrefix.some(Boolean)
                ? { input: [...inputPrefix, providerInput.input].filter(Boolean).join("\n\n") }
                : {}),
              ...(providerContext ? { persistentMemoryContext: providerContext } : {}),
            })
            .pipe(
              Effect.tap((result) =>
                Effect.gen(function* () {
                  if (!hasLegacyPending(key, pendingMemory)) return;
                  pendingMemory.turnId = String(result.turnId);
                  if (input.hiddenWake === true)
                    legacyHiddenWakeByTurn.set(`${key}:${pendingMemory.turnId}`, true);
                  pendingMemory.dispatchReturned = true;
                  for (const event of pendingMemory.earlyEvents) {
                    if (String(event.turnId) !== pendingMemory.turnId) continue;
                    if (
                      event.type === "content.delta" &&
                      event.payload.streamKind === "assistant_text"
                    ) {
                      pendingMemory.assistant += event.payload.delta;
                    }
                  }
                  pendingMemory.earlyEvents.length = 0;
                  yield* drainLegacyTerminals(key);
                }),
              ),
              Effect.tapError(() =>
                Effect.gen(function* () {
                  if (hasLegacyPending(key, pendingMemory)) {
                    restoreLegacyMemoryHandler(key, pendingMemory);
                    removeLegacyPending(key, pendingMemory);
                  }
                  if (memoryTurn) {
                    yield* Effect.promise(() => memoryTurn.abandon());
                  }
                  yield* drainLegacyTerminals(key);
                }),
              ),
            );
        }
        const turnAdmissionGeneration = active.turnAdmissionGeneration;
        if (input.timezone !== undefined) {
          active.configuredToolSession = {
            ...active.configuredToolSession,
            timezone: input.timezone,
          };
          if (!active.activeTurn && !active.admittingTurn && active.pendingTurns.length === 0) {
            active.toolSession = active.configuredToolSession;
            toolRuntime.registerSession(key, active.toolSession);
          }
        }
        const attachmentFiles = yield* Effect.forEach(
          input.attachments ?? [],
          (attachment) => {
            const path = resolveAttachmentPath({
              attachmentsDir: config.attachmentsDir,
              attachment,
            });
            if (path === null) {
              return Effect.fail(
                new AgentControllerRuntimeError({
                  operation: "sendTurn.attachments",
                  detail: `Attachment '${attachment.id}' has an invalid path.`,
                }),
              );
            }
            return Effect.tryPromise({
              try: async () => {
                const bytes = await (options?.readAttachment ?? NodeFS.promises.readFile)(path);
                return {
                  file: {
                    data: Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString(
                      "base64",
                    ),
                    mediaType: attachment.mimeType,
                    filename: attachment.name,
                  },
                  pathLine: `[Attached ${attachment.type} "${attachment.name}" is saved at: ${path}]`,
                };
              },
              catch: (cause) =>
                new AgentControllerRuntimeError({
                  operation: "sendTurn.attachments",
                  detail: `Could not read attachment '${attachment.id}'.`,
                  cause,
                }),
            });
          },
          { concurrency: 1 },
        );
        if (
          sessions.get(key) !== active ||
          active.status === "closed" ||
          active.turnAdmissionGeneration !== turnAdmissionGeneration
        ) {
          return yield* new AgentControllerRuntimeError({
            operation: "sendTurn",
            detail: `Mastra session for thread '${input.threadId}' is not running.`,
          });
        }
        const content = [input.input, ...attachmentFiles.map(({ pathLine }) => pathLine)]
          .filter((part): part is string => typeof part === "string" && part.length > 0)
          .join("\n\n");
        const files = attachmentFiles.map(({ file }) => file);
        const turnId = TurnId.make(`mastra-turn-${NodeCrypto.randomUUID()}`);
        active.pendingTurns.push({
          threadId: input.threadId,
          turnId,
          message: { content, ...(files.length > 0 ? { files } : {}) },
          botUsage: input.botUsage,
          toolSession: active.configuredToolSession,
          memoryAccess: active.configuredMemoryAccess,
          entityMemoryAccess: active.configuredEntityMemoryAccess,
          reviewInput: input.input ?? "",
          hiddenWake: input.hiddenWake === true,
          delegationResults: input.delegationResults,
        });
        if (!active.activeTurn && !active.admittingTurn) {
          const nextTurn = active.pendingTurns.shift();
          if (nextTurn) {
            yield* admitPendingTurn(active, nextTurn).pipe(
              Effect.tapError((cause) =>
                Effect.promise(() => handlePendingTurnFailure(active, nextTurn, cause)),
              ),
            );
          }
        }
        return { threadId: input.threadId, turnId };
      },
    );

    const interruptTurn: AgentControllerShape["interruptTurn"] = Effect.fn(
      "AgentController.interruptTurn",
    )(function* (input) {
      const key = String(input.threadId);
      const active = sessions.get(key);
      if (!active) {
        if (
          usesMastraCode(resolvedByThread.get(key)?.provider ?? ProviderDriverKind.make("codex"))
        ) {
          return;
        }
        return yield* legacyProviderBridge.interruptTurn(input).pipe(
          Effect.ensuring(
            Effect.gen(function* () {
              const pendingTurns = legacyPending(key);
              for (const pending of pendingTurns) restoreLegacyMemoryHandler(key, pending);
              legacyTurnMemory.delete(key);
              legacyBufferedTerminals.delete(key);
              yield* Effect.forEach(
                pendingTurns,
                (pendingMemory) =>
                  pendingMemory.memoryTurn
                    ? runMastra("memory.abandon", () => pendingMemory.memoryTurn!.abandon()).pipe(
                        Effect.ignoreCause({ log: true }),
                      )
                    : Effect.void,
                { discard: true },
              );
            }),
          ),
        );
      }
      active.turnAdmissionGeneration += 1;
      active.pendingTurns.length = 0;
      active.admittingTurn = null;
      active.session.abort();
      yield* cancelActiveImageGenerations(input.threadId);
      yield* releaseMastraReservations(input.threadId);
      finishTurn(input.threadId, active, "interrupted");
    });

    const respondToRequest: AgentControllerShape["respondToRequest"] = Effect.fn(
      "AgentController.respondToRequest",
    )(function* (input) {
      const key = String(input.threadId);
      const active = sessions.get(key);
      if (!active) {
        if (
          usesMastraCode(resolvedByThread.get(key)?.provider ?? ProviderDriverKind.make("codex"))
        ) {
          return yield* new AgentControllerRuntimeError({
            operation: "respondToRequest",
            detail: `Stale pending approval request: ${input.requestId}. The bot session restarted. Send the request again.`,
          });
        }
        return yield* legacyProviderBridge.respondToRequest(input);
      }
      const routing = yield* legacyProviderBridge.getInstanceInfo(active.providerInstanceId);
      if (!routing.enabled) {
        return yield* disabledProviderError(
          "AgentController.respondToRequest",
          active.providerInstanceId,
        );
      }
      if (!active.activeTurn) {
        return yield* new AgentControllerRuntimeError({
          operation: "respondToRequest",
          detail: `Stale pending approval request: ${input.requestId}. The bot turn has ended. Send the request again.`,
        });
      }
      const toolCallId = String(input.requestId);
      const openRoutineRequest = pendingRoutineRequests.get(toolCallId);
      if (openRoutineRequest && openRoutineRequest.threadId !== key) {
        return yield* new AgentControllerRuntimeError({
          operation: "respondToRequest",
          detail: `The routine review belongs to another chat: ${input.requestId}.`,
        });
      }
      // Claiming the review first stops its timeout, so an answer that arrives
      // in time always decides the outcome even if creation outlasts the limit.
      const routineRequest = pendingRoutineRequests.claim(toolCallId);
      if (routineRequest) {
        // The review stays open until its answer has taken effect, so an
        // accepted review keeps the turn waiting while the routine is created.
        const resolveReview = (outcome?: "failed") =>
          Effect.sync(() => {
            const current = sessions.get(key);
            if (!current?.activeTurn) return;
            current.activeTurn.waiting = turnStillWaiting(key, current);
            publish({
              ...baseEvent(input.threadId, current, current.activeTurn.turnId),
              requestId: RuntimeRequestId.make(toolCallId),
              type: "request.resolved",
              payload: {
                requestType: "dynamic_tool_call" as const,
                decision: input.decision,
                ...(outcome ? { outcome } : {}),
              },
            });
            publishSessionState(
              input.threadId,
              current,
              current.activeTurn.waiting ? "waiting" : "running",
            );
          });
        if (input.decision === "decline" || input.decision === "cancel") {
          yield* resolveReview();
          pendingRoutineRequests.resolve(toolCallId, { status: "cancelled" });
          return;
        }
        creatingRoutineReviews.set(toolCallId, key);
        let created = false;
        yield* routineDispatcher!
          .createApprovedForThread(
            ThreadIdBrand(routineRequest.threadId),
            routineRequest.timezone,
            routineRequest.input,
          )
          .pipe(
            Effect.mapError(
              (cause) =>
                new AgentControllerRuntimeError({
                  operation: "respondToRequest.routine",
                  detail: cause.message,
                  cause,
                }),
            ),
            Effect.tap((result) =>
              Effect.sync(() => {
                created = true;
                pendingRoutineRequests.resolve(toolCallId, result);
              }),
            ),
            Effect.tapError((cause) =>
              Effect.sync(() => {
                pendingRoutineRequests.reject(toolCallId, cause);
              }),
            ),
            Effect.onInterrupt(() =>
              Effect.sync(() => {
                pendingRoutineRequests.reject(
                  toolCallId,
                  new Error("The routine review was interrupted before the routine was created."),
                );
              }),
            ),
            Effect.ensuring(
              Effect.suspend(() => {
                creatingRoutineReviews.delete(toolCallId);
                return resolveReview(created ? undefined : "failed");
              }),
            ),
          );
        return;
      }
      const toolRequest = active.approvalRequests.get(toolCallId);
      const pendingApproval = active.pendingApprovals.get(toolCallId);
      if (!toolRequest || !pendingApproval) {
        return yield* new AgentControllerRuntimeError({
          operation: "respondToRequest",
          detail: `Stale pending approval request: ${input.requestId}. The request is no longer active.`,
        });
      }
      const { name: toolName, input: toolInput } = toolRequest;
      const akeruTool = AKERU_TOOL_CATALOG.find((tool) => tool.id === toolName);
      const runtimeToolId = akeruTool?.id ?? (isMemoryToolId(toolName) ? toolName : undefined);
      const acceptForSession =
        input.decision === "acceptForSession" &&
        !runtimeToolId &&
        !isCodexComputerUseTool(toolName) &&
        !akeruActionNeedsApproval(toolName, toolInput) &&
        toolName !== AKERU_PRODUCT_FEEDBACK_TOOL_NAME;
      const enableAutoReview =
        input.decision === "acceptAlways" &&
        !isCodexComputerUseTool(toolName) &&
        !akeruActionNeedsApproval(toolName, toolInput) &&
        toolName !== AKERU_PRODUCT_FEEDBACK_TOOL_NAME &&
        toolName !== AKERU_CREATE_ROUTINE_TOOL_NAME;
      const target = pendingApproval.toolName;
      const decision =
        input.decision === "acceptForSession" || input.decision === "acceptAlways"
          ? "accept"
          : input.decision;
      const admitted = yield* legacyProviderBridge.dispatchIfEnabled(
        active.providerInstanceId,
        "AgentController.respondToRequest",
        () => {
          if (!active.activeTurn || active.approvalRequests.get(toolCallId) !== toolRequest) {
            return { _tag: "Stale" as const };
          }
          active.approvalRequests.delete(toolCallId);
          active.pendingApprovals.delete(toolCallId);
          if (runtimeToolId && input.decision !== "decline" && input.decision !== "cancel") {
            toolRuntime.grantApproval({
              threadId: key,
              toolCallId,
              toolId: runtimeToolId,
              input: toolInput,
            });
          }
          // Auto Review lets permissionPolicy run the rest of this session; risky
          // one-use actions still ask.
          if (enableAutoReview) active.runtimeMode = "auto";
          const update = acceptForSession
            ? active.session.permissions.setForTool({ toolName, policy: "allow" })
            : undefined;
          if (acceptForSession) active.connectorSessionApprovals.add(toolName);
          if (active.activeTurn) active.activeTurn.waiting = turnStillWaiting(key, active);
          active.session.respondToToolApproval({
            toolCallId,
            decision:
              runtimeToolId && input.decision !== "decline" && input.decision !== "cancel"
                ? "approve"
                : approvalDecision(decision),
          });
          return { _tag: "Dispatched" as const, permissionUpdate: update };
        },
      );
      if (admitted._tag === "Stale") {
        return yield* new AgentControllerRuntimeError({
          operation: "respondToRequest",
          detail: `Stale pending approval request: ${input.requestId}. The bot turn has ended. Send the request again.`,
        });
      }
      const permissionUpdate = admitted.permissionUpdate;
      if (permissionUpdate) {
        yield* runMastra("permissions.setForTool", () => permissionUpdate);
      }
      publish({
        ...baseEvent(input.threadId, active, active.activeTurn?.turnId),
        requestId: RuntimeRequestId.make(toolCallId),
        type: "request.resolved",
        payload: {
          requestType: "dynamic_tool_call" as const,
          decision,
          actor: "user",
          target,
          action: pendingApproval.action,
          outcome: decision === "accept" ? "approved" : "denied",
        },
      });
      publishSessionState(
        input.threadId,
        active,
        active.activeTurn?.waiting ? "waiting" : "running",
      );
    });

    const respondToUserInput: AgentControllerShape["respondToUserInput"] = Effect.fn(
      "AgentController.respondToUserInput",
    )(function* (input) {
      const key = String(input.threadId);
      const active = sessions.get(key);
      if (!active) {
        if (
          usesMastraCode(resolvedByThread.get(key)?.provider ?? ProviderDriverKind.make("codex"))
        ) {
          return yield* new AgentControllerRuntimeError({
            operation: "respondToUserInput",
            detail: `Unknown pending user-input request: ${input.requestId}. The bot session restarted. Send the request again.`,
          });
        }
        return yield* legacyProviderBridge.respondToUserInput(input);
      }
      const routing = yield* legacyProviderBridge.getInstanceInfo(active.providerInstanceId);
      if (!routing.enabled) {
        return yield* disabledProviderError(
          "AgentController.respondToUserInput",
          active.providerInstanceId,
        );
      }
      const toolCallId = String(input.requestId);
      const answer = input.answers[toolCallId];
      if (answer === undefined) {
        return yield* new AgentControllerRuntimeError({
          operation: "respondToToolSuspension",
          detail: `No answer was supplied for pending user-input request '${toolCallId}'.`,
        });
      }
      const activeTurn = active.activeTurn;
      // Only a question this turn was waiting on goes back into its set on failure.
      let ownedByTurn = false;
      let restored = false;
      let resumeFailure: string | undefined;
      const unsubscribe = active.session.subscribe((event) => {
        if (event.type === "tool_suspension_cancelled" && event.toolCallId === toolCallId) {
          resumeFailure = event.reason;
        } else if (event.type === "error") {
          resumeFailure ??= event.error.message;
        }
      });
      yield* Effect.gen(function* () {
        const admitted = yield* legacyProviderBridge.dispatchIfEnabled(
          active.providerInstanceId,
          "AgentController.respondToUserInput",
          () => {
            if (!activeTurn || active.activeTurn !== activeTurn) {
              return { _tag: "Stale" as const };
            }
            ownedByTurn = activeTurn.suspendedToolCalls.delete(toolCallId);
            activeTurn.waiting = turnStillWaiting(key, active);
            return {
              _tag: "Dispatched" as const,
              resume: active.session.respondToToolSuspension({ toolCallId, resumeData: answer }),
            };
          },
        );
        if (admitted._tag === "Stale") {
          return yield* new AgentControllerRuntimeError({
            operation: "respondToUserInput",
            detail: `Unknown pending user-input request: ${input.requestId}. The bot turn has ended. Send the request again.`,
          });
        }
        yield* runMastra("respondToToolSuspension", () => admitted.resume).pipe(
          // A rejected resume leaves the question open while its turn is still live.
          Effect.onError(() =>
            Effect.sync(() => {
              if (
                !ownedByTurn ||
                !activeTurn ||
                active.activeTurn !== activeTurn ||
                resumeFailure !== undefined
              )
                return;
              activeTurn.suspendedToolCalls.add(toolCallId);
              activeTurn.waiting = turnStillWaiting(key, active);
              restored = true;
            }),
          ),
          Effect.mapError((error) =>
            restored
              ? new AgentControllerRuntimeError({
                  operation: error.operation,
                  detail: error.detail,
                  cause: error.cause,
                  retryable: true,
                })
              : error,
          ),
        );
      }).pipe(Effect.ensuring(Effect.sync(unsubscribe)));
      if (resumeFailure !== undefined) {
        return yield* new AgentControllerRuntimeError({
          operation: "respondToToolSuspension",
          detail: `Unknown pending user-input request: ${toolCallId}. ${resumeFailure}`,
          cause: new Error(resumeFailure),
        });
      }
      publish({
        ...baseEvent(input.threadId, active, active.activeTurn?.turnId),
        requestId: RuntimeRequestId.make(toolCallId),
        type: "user-input.resolved",
        payload: { answers: input.answers },
      });
      publishSessionState(
        input.threadId,
        active,
        active.activeTurn?.waiting ? "waiting" : "running",
      );
    });

    const stopSessionWithResources = Effect.fn("AgentController.stopSession")(function* (
      input: Parameters<AgentControllerShape["stopSession"]>[0],
      destroyResources: boolean,
    ) {
      // A stopped chat must not receive an image that finishes later.
      yield* cancelActiveImageGenerations(input.threadId);
      const key = String(input.threadId);
      const active = sessions.get(key);
      if (!active) {
        const legacySessions = yield* legacyProviderBridge.listSessions();
        if (legacySessions.some((session) => session.threadId === input.threadId)) {
          const pendingTurns = legacyPending(key);
          for (const pending of pendingTurns) restoreLegacyMemoryHandler(key, pending);
          legacyTurnMemory.delete(key);
          legacyBufferedTerminals.delete(key);
          yield* Effect.forEach(
            pendingTurns,
            (pendingMemory) =>
              pendingMemory.memoryTurn
                ? runMastra("memory.abandon", () => pendingMemory.memoryTurn!.abandon()).pipe(
                    Effect.ignoreCause({ log: true }),
                  )
                : Effect.void,
            { discard: true },
          );
          yield* legacyProviderBridge.stopSession(input).pipe(
            Effect.ensuring(
              Effect.gen(function* () {
                yield* runMastra("resources.release", () =>
                  sessionResources.release(key, { destroy: destroyResources }),
                ).pipe(Effect.ignoreCause({ log: true }));
                yield* clearPreviewMcpSession(input.threadId);
                legacyResourceIdentity.delete(key);
              }),
            ),
          );
          return;
        }
        if (
          usesMastraCode(resolvedByThread.get(key)?.provider ?? ProviderDriverKind.make("codex"))
        ) {
          yield* runMastra("resources.release", () =>
            sessionResources.release(key, { destroy: destroyResources }),
          ).pipe(Effect.ignoreCause({ log: true }));
          yield* clearPreviewMcpSession(input.threadId);
          toolRuntime.unregisterSession(key);
          return;
        }
        return yield* legacyProviderBridge.stopSession(input);
      }
      active.turnAdmissionGeneration += 1;
      active.pendingTurns.length = 0;
      active.admittingTurn = null;
      active.session.abort();
      yield* releaseMastraReservations(input.threadId);
      if (active.activeTurn) {
        finishTurn(input.threadId, active, "interrupted");
      } else {
        cancelAllPendingApprovals(input.threadId, active);
      }
      active.unsubscribe();
      publishSessionState(input.threadId, active, "stopped");
      yield* runMastra("deleteSession", () =>
        bundle.controller.deleteSession({ resourceId: key }),
      ).pipe(
        Effect.ensuring(
          Effect.gen(function* () {
            yield* runMastra("resources.release", () =>
              sessionResources.release(key, { destroy: destroyResources }),
            ).pipe(Effect.ignoreCause({ log: true }));
            yield* clearPreviewMcpSession(input.threadId);
            toolRuntime.unregisterSession(key);
            sessions.delete(key);
            memoryUsageByThread.delete(key);
            yield* workerRuntime.releaseThread(input.threadId);
            workerTurnDefaults.delete(key);
          }),
        ),
      );
    });

    const stopSession: AgentControllerShape["stopSession"] = (input) =>
      stopSessionWithResources(input, false);

    const rollbackConversation: AgentControllerShape["rollbackConversation"] = Effect.fn(
      "AgentController.rollbackConversation",
    )(function* (input) {
      if (input.numTurns === 0) return;
      const resolved = resolvedByThread.get(String(input.threadId));
      if (!sessions.has(String(input.threadId)) && !resolved) {
        return yield* legacyProviderBridge.rollbackConversation(input);
      }
      if (resolved && !usesMastraCode(resolved.provider)) {
        return yield* legacyProviderBridge.rollbackConversation(input);
      }
      const active = sessions.get(String(input.threadId));
      if (
        !active ||
        !bundle.rebuildConversation ||
        Option.isNone(projectionMessages) ||
        Option.isNone(projectionTurns)
      ) {
        return yield* new AgentControllerRuntimeError({
          operation: "rollbackConversation",
          detail: "Conversation history is unavailable for rebuilding the provider session.",
        });
      }
      const turns = yield* projectionTurns.value.listByThreadId({ threadId: input.threadId });
      const messages = yield* projectionMessages.value.listByThreadId({ threadId: input.threadId });
      const currentTurnCount = turns.reduce(
        (count, turn) => Math.max(count, turn.checkpointTurnCount ?? 0),
        0,
      );
      const retained = retainProjectionMessagesAfterRevert(
        messages,
        turns,
        Math.max(0, currentTurnCount - input.numTurns),
      );
      const key = String(input.threadId);
      const transcript: MastraDBMessage[] = yield* Effect.forEach(retained, (message) =>
        Effect.try({
          try: () => ({
            id: String(message.messageId),
            role: message.role,
            content: {
              format: 2 as const,
              parts: [
                {
                  type: "text" as const,
                  text: [
                    message.text,
                    ...(message.attachments ?? []).map((attachment) => {
                      const path = resolveAttachmentPath({
                        attachmentsDir: config.attachmentsDir,
                        attachment,
                      });
                      return `[Attached ${attachment.type} "${attachment.name}" is saved at: ${path}]`;
                    }),
                  ]
                    .filter(Boolean)
                    .join("\n\n"),
                },
              ],
              ...(message.attachments?.length
                ? {
                    experimental_attachments: message.attachments.map((attachment) => {
                      const path = resolveAttachmentPath({
                        attachmentsDir: config.attachmentsDir,
                        attachment,
                      });
                      if (path === null) throw new Error(`Invalid attachment '${attachment.id}'.`);
                      return {
                        name: attachment.name,
                        contentType: attachment.mimeType,
                        url: `data:${attachment.mimeType};base64,${NodeFS.readFileSync(path).toString("base64")}`,
                      };
                    }),
                  }
                : {}),
            },
            createdAt: DateTime.toDate(DateTime.makeUnsafe(message.createdAt)),
            threadId: key,
            resourceId: key,
          }),
          catch: (cause) =>
            new AgentControllerRuntimeError({
              operation: "rollbackConversation",
              detail: "Could not rebuild retained conversation attachments.",
              cause,
            }),
        }),
      );
      const startInput = {
        ...active.startInput,
        runtimeMode: active.runtimeMode,
        ...(resolved ? { modelSelection: resolved.modelSelection } : {}),
      };
      const drainLifetime = new AbortController();
      const drained = (async () => {
        while (
          !drainLifetime.signal.aborted &&
          (active.session.stream.isActive() || active.session.run.getRunId() !== null)
        ) {
          const wake = new AbortController();
          const cancel = () => wake.abort();
          drainLifetime.signal.addEventListener("abort", cancel, { once: true });
          try {
            await Promise.race([
              active.session.stream.waitForTeardown(wake.signal),
              active.session.run.waitForTeardown(wake.signal),
            ]);
          } finally {
            drainLifetime.signal.removeEventListener("abort", cancel);
            wake.abort();
          }
        }
      })();
      yield* interruptTurn({ threadId: input.threadId });
      yield* runMastra("drainConversation", async () => {
        await Promise.allSettled([...active.pendingDispatches]);
        await drained;
      }).pipe(Effect.ensuring(Effect.sync(() => drainLifetime.abort())));
      yield* stopSession({ threadId: input.threadId });
      const restore = yield* runMastra("rebuildConversation", () =>
        bundle.rebuildConversation!(key, transcript),
      );
      // A failed restart restores the original transcript and reopens its session, so the chat
      // keeps a live provider session even though the revert fails.
      yield* startSession(input.threadId, startInput).pipe(
        Effect.catch((error) =>
          runMastra("restoreConversation", restore).pipe(
            Effect.andThen(
              startSession(input.threadId, startInput).pipe(Effect.ignoreCause({ log: true })),
            ),
            Effect.andThen(Effect.fail(error)),
          ),
        ),
      );
    });

    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        for (const [threadId, active] of sessions) {
          active.turnAdmissionGeneration += 1;
          active.pendingTurns.length = 0;
          active.admittingTurn = null;
          active.session.abort();
          if (active.activeTurn) {
            finishTurn(ThreadId.make(threadId), active, "interrupted");
          }
          active.unsubscribe();
          yield* releaseMastraReservations(ThreadId.make(threadId));
          yield* runMastra("deleteSession", () =>
            bundle.controller.deleteSession({ resourceId: threadId }),
          ).pipe(Effect.ignoreCause({ log: true }));
          yield* clearPreviewMcpSession(ThreadId.make(threadId));
          toolRuntime.unregisterSession(threadId);
        }
        for (const threadId of legacyResourceIdentity.keys()) {
          yield* clearPreviewMcpSession(ThreadId.make(threadId));
        }
        for (const pendingTurns of legacyTurnMemory.values()) {
          for (const pending of pendingTurns) {
            if (pending.memoryTurn) {
              yield* runMastra("memory.abandon", () => pending.memoryTurn!.abandon()).pipe(
                Effect.ignoreCause({ log: true }),
              );
            }
          }
        }
        legacyTurnMemory.clear();
        legacyBufferedTerminals.clear();
        legacyResourceIdentity.clear();
        sessions.clear();
        yield* runMastra("resources.shutdown", () => sessionResources.shutdown()).pipe(
          Effect.ignoreCause({ log: true }),
        );
      }),
    );

    return AgentController.of({
      configurePluginRuntime: (input: AkeruPluginRuntimeOptions) =>
        Ref.update(lateWiring, (current) => ({
          ...current,
          pluginRuntimeOptions: input,
          pluginRuntime: createAkeruPluginRuntime(input),
        })),
      configureDelegation: (input) =>
        Ref.update(lateWiring, (current) => ({
          ...current,
          botStateRuntime: createAkeruBotStateRuntime(input),
          channelRuntime: createAkeruChannelRuntime(input),
          delegationRuntime: current.delegationRuntime ?? makeDelegationRuntime(input),
          workerOrchestration: current.workerOrchestration ?? input,
        })),
      failDelegation: ({ threadId, error }) =>
        Effect.sync(() =>
          resolveChildWaiter(threadId, { state: "failed", turnId: null, error }),
        ).pipe(
          Effect.andThen(workerRuntime.childTurnFinished(threadId, { state: "failed", error })),
        ),
      dispatchDelegation: (input) =>
        Effect.tryPromise({
          try: async () => {
            const dispatchDelegation = wired().delegationRuntime?.dispatchDelegation;
            if (!dispatchDelegation) throw new Error("Bot work is not available yet.");
            return dispatchDelegation(input);
          },
          catch: (cause) =>
            new AgentControllerRuntimeError({
              operation: "dispatchDelegation",
              detail: failureDetail(cause),
              cause,
            }),
        }),
      authenticateMcpServer: ({ server, onAuthorizationUrl }) =>
        runMastra("mcp.authenticate", async (signal) => {
          const recoveryFailures: string[] = [];
          const managerSessions = sessionResources.getMcpManagerSessionsForServer(
            String(server.id),
          );
          const status = await authenticateMcpServer({
            server,
            managers: managerSessions.map(({ manager }) => manager),
            managerThreadIds: managerSessions.map(({ threadId }) => threadId),
            createManager: () =>
              (options?.makeMcpManager ?? createMcpManager)(
                NodePath.join(config.stateDir, "bot-mcp-runtime"),
                ".akeru-runtime",
                toMcpServerConfigs([server]),
              ),
            onAuthorizationUrl,
            signal,
            recordSuccess: (serverId) => subscriptionAuth.recordMcpRequestSuccess(serverId),
            recordFailure: (serverId, message) =>
              subscriptionAuth.recordMcpRequestFailure(serverId, message),
            recordRecoveryFailure: (serverId, message) => {
              recoveryFailures.push(message);
              fork("MCP session recovery failed after authentication.", Effect.fail(message), {
                serverId,
              });
            },
          });
          return { toolCount: status.toolCount, recoveryFailures };
        }),
      readConversationMemory: (threadId) =>
        bundle.readObservationalMemory
          ? runMastra("memory.read", () =>
              bundle.readObservationalMemory!(String(threadId), String(threadId)),
            )
          : Effect.fail(
              new AgentControllerRuntimeError({
                operation: "memory.read",
                detail: "Conversation memory is unavailable.",
              }),
            ),
      clearConversationMemory: (threadId) =>
        bundle.clearObservationalMemory
          ? runMastra("memory.clear", () =>
              bundle.clearObservationalMemory!(String(threadId), String(threadId)),
            )
          : Effect.fail(
              new AgentControllerRuntimeError({
                operation: "memory.clear",
                detail: "Conversation memory is unavailable.",
              }),
            ),
      restoreConversationMemory: (threadId, snapshot, expectedSnapshot) =>
        bundle.restoreObservationalMemory
          ? runMastra("memory.restore", () =>
              bundle.restoreObservationalMemory!(
                String(threadId),
                snapshot,
                String(threadId),
                expectedSnapshot,
              ),
            )
          : Effect.fail(
              new AgentControllerRuntimeError({
                operation: "memory.restore",
                detail: "Conversation memory restoration is unavailable.",
              }),
            ),
      resolveEngine,
      inspectEngine,
      startSession,
      sendTurn,
      interruptTurn,
      respondToRequest,
      respondToUserInput,
      stopSession,
      listSessions: () =>
        Effect.map(legacyProviderBridge.listSessions(), (legacySessions) => [
          ...legacySessions,
          ...[...sessions.entries()].map(([threadId, active]) =>
            toProviderSession(ThreadIdBrand(threadId), active),
          ),
        ]),
      rollbackConversation,
      uploadFeedback: legacyProviderBridge.uploadFeedback,
      get streamEvents() {
        return Stream.merge(
          legacyProviderBridge.streamEvents,
          Stream.fromPubSub(runtimeEvents),
        ).pipe(
          Stream.map((event) => {
            if (event.type !== "turn.started") return event;
            const key = String(event.threadId);
            const hiddenWake =
              event.turnId === undefined
                ? false
                : legacyHiddenWakeByTurn.get(`${key}:${String(event.turnId)}`) === true ||
                  legacyPending(key).some(
                    (pending) => !pending.dispatchReturned && pending.hiddenWake,
                  );
            return hiddenWake
              ? { ...event, payload: { ...event.payload, hiddenWake: true } }
              : event;
          }),
          Stream.tap((event) =>
            Effect.gen(function* () {
              const key = String(event.threadId);
              recordProviderAccessHealth(
                subscriptionAuth,
                event,
                resolvedByThread.get(key)?.modelSelection.model,
              );
              if (sessions.has(key)) return;
              const pendingTurns = legacyPending(key);
              if (pendingTurns.length === 0) return;
              const unseenPending = pendingTurns.filter(
                (pending) => !pending.seenEventIds.has(String(event.eventId)),
              );
              if (unseenPending.length === 0) return;
              for (const pending of unseenPending) {
                pending.seenEventIds.add(String(event.eventId));
              }
              if (event.type === "turn.completed" || event.type === "turn.aborted") {
                if (event.turnId) legacyHiddenWakeByTurn.delete(`${key}:${String(event.turnId)}`);
                if (!event.turnId) return;
                const terminals = legacyBufferedTerminals.get(key) ?? new Map();
                terminals.set(String(event.turnId), event);
                legacyBufferedTerminals.set(key, terminals);
                for (const pending of unseenPending) {
                  if (!pending.dispatchReturned) {
                    pending.earlyEvents.push(event);
                  }
                }
                yield* drainLegacyTerminals(key);
                return;
              }
              for (const pending of unseenPending) {
                if (!pending.dispatchReturned) {
                  if (event.type === "content.delta") {
                    pending.earlyEvents.push(event);
                  }
                  continue;
                }
                if (!event.turnId || String(event.turnId) !== pending.turnId) continue;
                if (
                  event.type === "content.delta" &&
                  event.payload.streamKind === "assistant_text"
                ) {
                  pending.assistant += event.payload.delta;
                  continue;
                }
              }
            }),
          ),
        );
      },
    });
  });

function ThreadIdBrand(value: string): ThreadId {
  return value as ThreadId;
}

function approvalDecision(decision: ProviderApprovalDecision): "approve" | "decline" {
  if (decision === "decline" || decision === "cancel") return "decline";
  return "approve";
}

function toProviderSession(threadId: ThreadId, active: ActiveSession): ProviderSession {
  return {
    provider: active.provider,
    providerInstanceId: active.providerInstanceId,
    status: active.status,
    runtimeMode: active.runtimeMode,
    ...(active.cwd ? { cwd: active.cwd } : {}),
    model: active.model,
    threadId,
    mcpServerIds: active.mcpServerIds,
    ...(active.activeTurn ? { activeTurnId: active.activeTurn.turnId } : {}),
    createdAt: active.createdAt,
    updatedAt: nowIso(),
  };
}

export const makeAgentControllerLive = (options?: AgentControllerLiveOptions) =>
  Layer.effect(AgentController, make(options));

export const AgentControllerLive = Layer.effect(
  AgentController,
  Effect.gen(function* () {
    const entityMemoryRepository = yield* EntityMemoryRepository;
    return yield* make({ entityMemoryRepository });
  }),
).pipe(
  Layer.provide(ProjectionThreadMessageRepositoryLive),
  Layer.provide(ProjectionTurnRepositoryLive),
);
