// @effect-diagnostics globalDate:off globalConsole:off globalRandom:off nodeBuiltinImport:off globalTimers:off
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
  ProviderDriverKind,
  ProviderInstanceId,
  RuntimeItemId,
  RuntimeRequestId,
  RoutineId,
  TurnId,
  AKERU_TOOL_CATALOG,
  DEFAULT_BOT_SANDBOX_BROWSER_SHARING,
  type BotId,
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
  type AkeruMemoryThreadAccess,
  type OrchestrationCommand,
  type OrchestrationReadModel,
  AKERU_CREATE_ROUTINE_TOOL_NAME,
} from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { getCodexServiceTierOptionValue } from "../../codexModelOptions.ts";
import { BotInboxService } from "../../bot-inbox/service.ts";
import { recordUserActionIncident } from "../../bot-inbox/userActionIncidents.ts";
import { ServerConfig } from "../../config.ts";
import { createMemoryToolHandlers } from "../../memory/MemoryToolHandlers.ts";
import {
  EntityMemoryRepository,
  type EntityMemoryRepositoryShape,
} from "../../memory/Services/EntityMemoryRepository.ts";
import {
  MemoryCandidateRepository,
  type MemoryCandidateRepositoryShape,
} from "../../memory/Services/MemoryCandidateRepository.ts";
import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as McpProviderSession from "../../mcp/McpProviderSession.ts";
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
  createAkeruMastraHarness,
  criticalAkeruAction,
  mastraModelId,
  type AkeruMastraHarness,
  type AkeruMastraHarnessOptions,
  type AkeruMastraSession,
} from "../AkeruMastraHarness.ts";
import { AKERU_BOT_TURN_INSTRUCTIONS } from "../AkeruAgentInstructions.ts";
import { createAkeruChannelRuntime, type AkeruChannelRuntime } from "../AkeruChannelRuntime.ts";
import { createAkeruBotStateRuntime, type AkeruBotStateRuntime } from "../AkeruBotStateRuntime.ts";
import {
  createAkeruDelegationRuntime,
  type AkeruDelegationChildOutcome,
  type AkeruDelegationRuntime,
  type AkeruDelegationRuntimeOptions,
} from "../AkeruDelegationRuntime.ts";
import {
  createAkeruCatalogToolHandlers,
  createAkeruPluginRuntime,
  type AkeruPluginRuntimeOptions,
} from "../AkeruCatalogToolHandlers.ts";
import { getMcpRuntimeHeaders, sameMcpServerConfigurations } from "../McpServerConfig.ts";
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
import type { AkeruBotWorkspace, CreateRemoteBotWorkspaceInput } from "../botWorkspace.ts";
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

const DEFAULT_MODE_ID = "build";
const PLAN_MODE_ID = "plan";
const BUILTIN_MASTRA_TOOL_NAMES: ReadonlySet<string> = new Set(
  Object.values(TOOL_NAME_OVERRIDES).map((tool) => tool.name),
);
const APPROVAL_FREE_MASTRA_TOOL_NAMES: ReadonlySet<string> = new Set(["ask_user"]);
type MastraSession = AkeruMastraSession;

interface ResolvedEngine {
  readonly modelSelection: ModelSelection;
  readonly provider: ProviderDriverKind;
  readonly providerInstanceId: ProviderInstanceId;
  readonly mastraModelId: string;
  readonly mode: "default" | "plan";
  readonly botConversation: boolean;
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
}

interface ActiveSession {
  readonly session: MastraSession;
  readonly provider: ProviderDriverKind;
  readonly providerInstanceId: ProviderInstanceId;
  readonly cwd: string | undefined;
  readonly createdAt: string;
  readonly mcpServerIds: readonly McpServer["id"][];
  readonly mcpServers: readonly McpServer[];
  runtimeMode: RuntimeMode;
  model: string;
  status: ProviderSession["status"];
  activeTurn: ActiveTurn | null;
  admittingTurn: PendingTurn | null;
  readonly pendingTurns: PendingTurn[];
  readonly toolNames: Map<string, string>;
  readonly approvalRequests: Map<string, { readonly name: string; readonly input: unknown }>;
  readonly connectorSessionApprovals: Set<string>;
  toolSession: AkeruToolSession;
  readonly workspaceResourceKey: string;
  readonly pendingApprovals: Map<string, PendingApproval>;
  readonly unsubscribe: () => void;
}

interface PendingApproval {
  readonly toolName: string;
  readonly action: string;
}

export interface AgentControllerLiveOptions {
  readonly makeMastraHarness?: (options: AkeruMastraHarnessOptions) => Promise<AkeruMastraHarness>;
  readonly makeMcpManager?: typeof createMcpManager;
  readonly makeRemoteWorkspace?: (
    input: CreateRemoteBotWorkspaceInput,
  ) => Promise<AkeruBotWorkspace | Workspace>;
  readonly makeBotBrowser?: (input: CreateBotBrowserInput) => BotBrowser;
  readonly resolveComputerUseServer?: typeof resolveCodexComputerUseServer;
  readonly issueMcpCredential?: typeof McpSessionRegistry.issueActiveMcpCredential;
  readonly revokeMcpCredential?: typeof McpSessionRegistry.revokeActiveMcpThread;
  readonly entityMemoryRepository?: EntityMemoryRepositoryShape;
  readonly memoryCandidateRepository?: MemoryCandidateRepositoryShape;
  readonly delegationRuntime?: Pick<
    AkeruDelegationRuntime,
    "send" | "sendToUser" | "parentFinished" | "accessForThread"
  > &
    Partial<Pick<AkeruDelegationRuntime, "create" | "check" | "stop">>;
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

const BROWSER_AWARE_MCP_SERVER_IDS = new Set(["builtin-executor", "builtin-tinyfish"]);

export function toMcpServerConfigs(
  servers: readonly McpServer[],
  browser?: BotBrowserAttachment,
): Record<string, McpServerConfig> {
  const browserRequestHeaders = browser ? JSON.stringify(browser.requestHeaders) : undefined;
  const browserEnvironment = browser
    ? {
        AKERU_BROWSER_MCP_URL: browser.browserUrl,
        AKERU_BROWSER_MCP_SESSION_ID: browser.mcpSessionId,
        AKERU_BROWSER_MCP_HEADERS: JSON.stringify(browser.localRequestHeaders),
      }
    : undefined;
  return Object.fromEntries(
    servers.map((server) => [
      String(server.id),
      server.transport === "url"
        ? {
            url: server.url,
            ...(Object.keys(getMcpRuntimeHeaders(server)).length > 0
              ? { headers: getMcpRuntimeHeaders(server) }
              : {}),
            ...(browser?.availableToHostedPlugins &&
            BROWSER_AWARE_MCP_SERVER_IDS.has(String(server.id))
              ? {
                  headers: {
                    "x-akeru-browser-mcp-url": browser.browserUrl,
                    "x-akeru-browser-mcp-session-id": browser.mcpSessionId,
                    "x-akeru-browser-mcp-headers": browserRequestHeaders!,
                  },
                }
              : {}),
          }
        : {
            command: server.command,
            ...(server.args ? { args: [...server.args] } : {}),
            ...(browserEnvironment && BROWSER_AWARE_MCP_SERVER_IDS.has(String(server.id))
              ? { env: browserEnvironment }
              : {}),
          },
    ]),
  );
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
  return !BUILTIN_MASTRA_TOOL_NAMES.has(toolName);
}

function approvalDetail(toolName: string, action: string | null, oneUse: boolean): string {
  if (!oneUse) return `Allow ${toolName}?`;
  const target = action ? `${action} action with ${toolName}` : `action with ${toolName}`;
  return `Approve this ${target}? This approval applies only to the pending action. It cannot undo completed work.`;
}

function usesMastraCode(provider: ProviderDriverKind): boolean {
  return provider === "codex" || provider === "kimi" || provider === "opencodeGo";
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
    case "cursor":
      return "cursor";
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

export function recordProviderAccessHealth(
  subscriptionAuth: SubscriptionAuthService,
  event: ProviderRuntimeEvent,
): void {
  const provider = subscriptionProviderForDriver(event.provider);
  const providerInstanceId = event.providerInstanceId;
  if (event.type === "turn.completed") {
    if (event.payload.state === "failed") {
      const message = event.payload.errorMessage ?? "The provider request failed.";
      if (provider) subscriptionAuth.recordRequestFailure(provider, message, event.createdAt);
      if (providerInstanceId) {
        subscriptionAuth.recordProviderInstanceFailure(
          providerInstanceId,
          message,
          event.createdAt,
        );
      }
    } else if (event.payload.state === "completed") {
      if (provider) subscriptionAuth.recordRequestSuccess(provider, event.createdAt);
      if (providerInstanceId) {
        subscriptionAuth.recordProviderInstanceSuccess(providerInstanceId, event.createdAt);
      }
    }
    return;
  }
  if (event.type !== "runtime.error" || event.payload.class !== "provider_error") return;
  if (provider) {
    subscriptionAuth.recordRequestFailure(provider, event.payload.message, event.createdAt);
  }
  if (providerInstanceId) {
    subscriptionAuth.recordProviderInstanceFailure(
      providerInstanceId,
      event.payload.message,
      event.createdAt,
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
    const runtimeContext = yield* Effect.context<never>();
    const runPromise = Effect.runPromiseWith(runtimeContext);
    const routineDraftDispatcher = yield* Effect.serviceOption(RoutineDraftDispatcher);
    const routineDispatcher = Option.getOrUndefined(routineDraftDispatcher);
    const mutationLock = yield* Semaphore.make(1);
    const runtimeEvents = yield* PubSub.unbounded<ProviderRuntimeEvent>();
    const orchestrationEngine = yield* Effect.serviceOption(OrchestrationEngineService);
    const projectionSnapshotQuery = yield* Effect.serviceOption(ProjectionSnapshotQuery);
    const resolvedByThread = new Map<string, ResolvedEngine>();
    const sessions = new Map<string, ActiveSession>();
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
        Effect.tap(() => Effect.sync(() => McpProviderSession.clearMcpProviderSession(threadId))),
      );
    const preparePreviewMcpSession = (threadId: ThreadId, providerInstanceId: ProviderInstanceId) =>
      Effect.gen(function* () {
        const enabled = Option.isSome(serverSettings)
          ? yield* serverSettings.value.getSettings.pipe(
              Effect.map((settings) => settings.enableAgentBrowserAccess),
              Effect.orElseSucceed(() => false),
            )
          : true;
        if (!enabled) {
          yield* clearPreviewMcpSession(threadId);
          return;
        }
        const credential = yield* issueMcpCredential({ threadId, providerInstanceId });
        if (credential) {
          yield* Effect.sync(() => McpProviderSession.setMcpProviderSession(credential.config));
        }
      });
    let channelRuntime: AkeruChannelRuntime | undefined;
    let pluginRuntime: ReturnType<typeof createAkeruPluginRuntime> | undefined;
    let pluginRuntimeOptions: AkeruPluginRuntimeOptions | undefined;
    let botStateRuntime: AkeruBotStateRuntime | undefined;
    const childWaiters = new Map<
      string,
      {
        readonly resolve: (outcome: AkeruDelegationChildOutcome) => void;
        readonly reject: (cause: Error) => void;
        readonly timer: ReturnType<typeof setTimeout> | undefined;
      }
    >();
    const resolveChildWaiter = (threadId: ThreadId, outcome: AkeruDelegationChildOutcome) => {
      const waiter = childWaiters.get(String(threadId));
      if (!waiter) return;
      if (waiter.timer) clearTimeout(waiter.timer);
      childWaiters.delete(String(threadId));
      waiter.resolve(outcome);
    };
    const pendingRoutineRequests = new Map<
      string,
      {
        readonly threadId: string;
        readonly input: AkeruCreateRoutineInput;
        readonly timezone: string;
        readonly resolve: (result: unknown) => void;
        readonly reject: (cause: unknown) => void;
      }
    >();

    const runMastra = <A>(operation: string, run: () => Promise<A>) =>
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
    const subscriptionAuth = SubscriptionAuthService.forSecretsDir(config.secretsDir);
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
      ...(options?.makeMcpManager ? { makeMcpManager: options.makeMcpManager } : {}),
      ...(options?.makeRemoteWorkspace ? { makeRemoteWorkspace: options.makeRemoteWorkspace } : {}),
      ...(options?.makeBotBrowser ? { makeBotBrowser: options.makeBotBrowser } : {}),
      ...(options?.resolveComputerUseServer
        ? { resolveComputerUseServer: options.resolveComputerUseServer }
        : {}),
    });
    const botInbox = BotInboxService.forSecretsDir(config.secretsDir);
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
    const memoryHandlers = (
      access: AkeruMemoryThreadAccess | undefined,
      allowedScopes?: AkeruDelegationAccessGrant["memoryScopes"],
    ) =>
      access && options?.entityMemoryRepository && options.memoryCandidateRepository
        ? createMemoryToolHandlers(
            options.entityMemoryRepository,
            options.memoryCandidateRepository,
            access,
            undefined,
            allowedScopes,
          )
        : undefined;
    const legacyResourceIdentity = new Map<
      string,
      {
        readonly workspaceResourceKey: string;
        readonly cwd: string | undefined;
        readonly provider: ProviderDriverKind;
        readonly providerInstanceId: ProviderInstanceId;
      }
    >();
    let delegationRuntime = options?.delegationRuntime;
    const delegationFor = (input: {
      readonly threadId: ThreadId;
      readonly botId: BotId;
      readonly parentDelegation: AkeruDelegationRecord | undefined;
      readonly access: AkeruDelegationAccessGrant;
      readonly snapshot: OrchestrationReadModel | undefined;
    }): NonNullable<AkeruToolSession["delegation"]> => {
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
        activeDelegations:
          input.snapshot?.delegations.filter(
            (candidate) =>
              candidate.parentThreadId === input.threadId &&
              candidate.state !== "completed" &&
              candidate.state !== "failed" &&
              candidate.state !== "canceled",
          ).length ?? 0,
        access: input.access,
        ...(createAgent ? { create: (request) => createAgent(parent(), request) } : {}),
        ...(checkAgent ? { check: (request) => checkAgent(parent(), request) } : {}),
        send: (request) => delegationRuntime!.send(parent(), request),
        ...(stopAgent ? { stop: (request) => stopAgent(parent(), request) } : {}),
      };
    };
    const makeMastraHarness = options?.makeMastraHarness ?? createAkeruMastraHarness;
    const bundle = yield* runMastra("construct", () =>
      makeMastraHarness({
        authStorage,
        getKimiAccess: () => subscriptionAuth.getKimiForCodingAccess(),
        getOpenCodeGoApiKey: () => subscriptionAuth.getAccessToken("opencode-go"),
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
                return new Promise((resolve, reject) => {
                  pendingRoutineRequests.set(requestId, {
                    threadId,
                    input,
                    timezone,
                    resolve,
                    reject,
                  });
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
                });
              },
            }
          : {}),
        toolRuntime,
        startMemoryCall: async ({ threadId, category }) => {
          const context = memoryUsageByThread.get(threadId);
          const active = sessions.get(threadId);
          if (!context || !active) return undefined;
          const callId = `${category}:${NodeCrypto.randomUUID()}`;
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
      }),
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
          new Promise((resolve, reject) => {
            const key = String(threadId);
            if (childWaiters.has(key)) {
              reject(new Error(`Delegation waiter already exists for '${threadId}'.`));
              return;
            }
            const delay = deadline === null ? undefined : Date.parse(deadline) - Date.now();
            if (delay !== undefined && delay <= 0) {
              reject(new Error("The delegation deadline expired."));
              return;
            }
            const timer =
              delay === undefined
                ? undefined
                : setTimeout(() => {
                    childWaiters.delete(key);
                    reject(new Error("The delegation deadline expired."));
                  }, delay);
            childWaiters.set(key, { resolve, reject, timer });
          }),
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
        recordUsage: async (usage) => {
          const active = sessions.get(String(usage.threadId));
          if (active) publish(delegatedUsageReceipt(usage, active));
        },
      });
    delegationRuntime ??=
      Option.isSome(orchestrationEngine) && Option.isSome(projectionSnapshotQuery)
        ? makeDelegationRuntime({
            readSnapshot: () => Effect.runPromise(projectionSnapshotQuery.value.getSnapshot()),
            dispatch: (command) => Effect.runPromise(orchestrationEngine.value.dispatch(command)),
          })
        : undefined;

    const queueTurnMemory = (threadId: ThreadId, active: ActiveSession, turn: ActiveTurn) => {
      const resolved = resolvedByThread.get(String(threadId));
      if (turn.memoryQueued || !bundle.observeAfterTurn || !resolved) return;
      turn.memoryQueued = true;
      void bundle
        .observeAfterTurn({
          threadId: String(threadId),
          resourceId: String(threadId),
          modelId: resolved.mastraModelId,
        })
        .catch((cause) => {
          turn.memoryQueued = false;
          Effect.runFork(
            Effect.logWarning("Akeru background observational memory failed.", {
              threadId,
              turnId: turn.turnId,
              cause,
            }),
          );
        });
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
      { threadId, turnId, botUsage }: PendingTurn,
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
        payload: { model: active.model },
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
      active.admittingTurn = null;
      beginPendingTurn(active, pending);
      const dispatch = active.session.sendMessage(message);
      void dispatch
        .then(() => {
          const turn = active.activeTurn;
          if (turn?.turnId === turnId && !turn.waiting) {
            finishTurn(threadId, active, "completed");
          }
        })
        .catch((cause: unknown) => handlePendingTurnFailure(active, pending, cause));
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
      void runPromise(admitPendingTurn(active, pending)).catch((cause: unknown) =>
        handlePendingTurnFailure(active, pending, cause),
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
      if (state !== "completed") {
        void delegationRuntime
          ?.parentFinished({ threadId, failed: state === "failed" })
          .catch((cause) => {
            publish({
              ...baseEvent(threadId, active, turn.turnId),
              type: "runtime.error",
              payload: { message: failureDetail(cause), class: "provider_error" },
            });
          });
      }
      for (const [requestId, request] of pendingRoutineRequests) {
        if (request.threadId !== String(threadId)) continue;
        pendingRoutineRequests.delete(requestId);
        request.reject(new Error("The routine review ended before it received a response."));
      }
      active.activeTurn = null;
      const nextTurn = active.pendingTurns.shift();
      if (nextTurn) {
        startPendingTurn(active, nextTurn);
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
          const action = criticalAkeruAction(event.toolName, event.args);
          const oneUseApproval =
            akeruActionNeedsApproval(event.toolName, event.args) ||
            mcpToolNeedsApproval(mcpManager, event.toolName);
          if (
            event.toolName !== AKERU_PRODUCT_FEEDBACK_TOOL_NAME &&
            !oneUseApproval &&
            permissionPolicy(active.runtimeMode, akeruToolCategory(event.toolName)) === "allow"
          ) {
            void runPromise(
              legacyProviderBridge.dispatchIfEnabled(
                active.providerInstanceId,
                "AgentController.handleControllerEvent",
                () => {
                  if (active.activeTurn !== turn || turn.finished) return;
                  active.session.respondToToolApproval({
                    toolCallId: event.toolCallId,
                    decision: "approve",
                  });
                },
              ),
            ).catch((cause: unknown) => {
              if (active.activeTurn !== turn || turn.finished) return;
              void failActiveTurn(active, threadId, turn.turnId, cause);
            });
            return;
          }
          active.approvalRequests.set(event.toolCallId, {
            name: event.toolName,
            input: event.args,
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
              args: isCodexComputerUseTool(event.toolName) ? undefined : event.args,
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
                    : AKERU_TOOL_CATALOG.some((tool) => tool.id === event.toolName) ||
                        isMemoryToolId(event.toolName) ||
                        oneUseApproval
                      ? [
                          { decision: "decline", label: "Decline" },
                          {
                            decision: "accept",
                            label: oneUseApproval ? "Approve" : "Allow",
                          },
                        ]
                      : [
                          { decision: "accept", label: "Allow" },
                          { decision: "acceptForSession", label: "Allow for session" },
                          { decision: "decline", label: "Decline" },
                        ],
            },
          });
          return;
        }
        case "tool_suspended":
          if (!turn) return;
          completeAssistantMessages(threadId, active, turn);
          active.toolNames.set(event.toolCallId, event.toolName);
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
          const resolved: ResolvedEngine = {
            modelSelection,
            provider: inspected.routing.driverKind,
            providerInstanceId: modelSelection.instanceId,
            mastraModelId: mastraModelId(inspected.routing.driverKind, modelSelection.model),
            mode: input.mode,
            botConversation: input.botConversation,
          };
          resolvedByThread.set(String(input.threadId), resolved);
          const active = sessions.get(String(input.threadId));
          if (active && usesMastraCode(resolved.provider)) {
            const { modelOptions: _priorModelOptions, ...activeState } = active.session.state.get();
            const nextModelOptions = mastraModelOptions(resolved);
            yield* runMastra("state.set", () =>
              active.session.state.set({
                ...activeState,
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

    const startSession: AgentControllerShape["startSession"] = Effect.fn(
      "AgentController.startSession",
    )(function* (threadId, input) {
      const key = String(threadId);
      const snapshot = Option.isSome(projectionSnapshotQuery)
        ? yield* projectionSnapshotQuery.value.getSnapshot()
        : undefined;
      const thread = snapshot?.threads.find((candidate) => candidate.id === threadId);
      const parentDelegation = snapshot?.delegations.find(
        (candidate) =>
          candidate.childThreadId === threadId &&
          candidate.state !== "completed" &&
          candidate.state !== "failed" &&
          candidate.state !== "canceled",
      );
      const respondingBotId = thread?.respondingBotId ?? thread?.botId ?? input.botId ?? null;
      const group = thread?.groupId
        ? snapshot?.groups.find((candidate) => candidate.id === thread.groupId)
        : undefined;
      const botId = respondingBotId ?? group?.bossBotId ?? null;
      const bot = snapshot?.bots.find((candidate) => candidate.id === botId);
      const delegatedAccess =
        delegationRuntime?.accessForThread(threadId) ?? parentDelegation?.access;
      const access: AkeruDelegationAccessGrant = delegatedAccess ?? {
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
      if (
        existing?.workspaceResourceKey === workspaceResourceKey &&
        existing.cwd === input.cwd &&
        existing.toolSession.workspaceType === workspaceType &&
        sameMcpServerConfigurations(existing.mcpServers, mcpServers) &&
        resolved &&
        existing.provider === resolved.provider &&
        existing.providerInstanceId === resolved.providerInstanceId
      ) {
        existing.runtimeMode = access.runtimeMode;
        yield* runMastra("state.set", () =>
          existing.session.state.set({
            ...(input.cwd ? { projectPath: input.cwd } : {}),
            yolo: false,
            botConversation: resolved.botConversation,
            botName: input.botName || "",
          }),
        );
        const toolSession = { ...existing.toolSession };
        delete toolSession.botId;
        delete toolSession.botName;
        delete toolSession.billedBotId;
        delete toolSession.delegation;
        delete toolSession.memoryHandlers;
        delete toolSession.botState;
        const nextMemoryHandlers =
          access.memoryScopes.length > 0
            ? memoryHandlers(input.memoryAccess, access.memoryScopes)
            : undefined;
        existing.toolSession = {
          ...toolSession,
          runtimeMode: access.runtimeMode,
          ...(botId ? { botId } : {}),
          ...(input.botName ? { botName: input.botName } : {}),
          ...(nextMemoryHandlers ? { memoryHandlers: nextMemoryHandlers } : {}),
          ...(delegatedAccess && botId ? { billedBotId: botId } : {}),
          ...(delegationRuntime && botId
            ? {
                delegation: delegationFor({
                  threadId,
                  botId,
                  parentDelegation,
                  access,
                  snapshot,
                }),
              }
            : {}),
          ...(input.botId && botStateRuntime ? { botState: botStateRuntime } : {}),
        };
        toolRuntime.registerSession(key, existing.toolSession);
        return toProviderSession(threadId, existing);
      }
      const existingLegacy = legacyResourceIdentity.get(key);
      if (
        !existing &&
        resolved &&
        existingLegacy?.workspaceResourceKey === workspaceResourceKey &&
        existingLegacy.cwd === input.cwd &&
        existingLegacy.provider === resolved.provider &&
        existingLegacy.providerInstanceId === resolved.providerInstanceId
      ) {
        const live = (yield* legacyProviderBridge.listSessions()).find(
          (session) => session.threadId === threadId,
        );
        if (live) return live;
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
      if (usesMastraCode(resolved.provider) && !(delegatedAccess && access.sandbox === null)) {
        yield* preparePreviewMcpSession(threadId, resolved.providerInstanceId);
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
              }),
            ).pipe(Effect.onError(() => clearPreviewMcpSession(threadId)));
      if (!usesMastraCode(resolved.provider)) {
        return yield* legacyProviderBridge.startSession(threadId, input).pipe(
          Effect.tap((session) =>
            Effect.sync(() => {
              legacyResourceIdentity.set(key, {
                workspaceResourceKey,
                cwd: input.cwd,
                provider: resolved.provider,
                providerInstanceId: resolved.providerInstanceId,
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
      const registeredMemoryHandlers =
        access.memoryScopes.length > 0
          ? memoryHandlers(input.memoryAccess, access.memoryScopes)
          : undefined;
      const mcpManager = sessionResources.getMcpManager(key);
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
        ...(input.botId && botStateRuntime ? { botState: botStateRuntime } : {}),
        catalogHandlers: createAkeruCatalogToolHandlers(
          mcpManager,
          pluginRuntime,
          mcpManager
            ? {
                getRequestHealth: (serverId) => subscriptionAuth.mcpRequestHealth(serverId),
                recordSuccess: (serverId, at) =>
                  subscriptionAuth.recordMcpRequestSuccess(serverId, at),
                recordFailure: (serverId, message, at) =>
                  subscriptionAuth.recordMcpRequestFailure(serverId, message, at),
                getDependencies: async (serverId) => {
                  const snapshot = await pluginRuntimeOptions?.readSnapshot();
                  return snapshot
                    ? {
                        dependentBots: snapshot.bots
                          .filter(
                            (bot) =>
                              bot.archivedAt === null &&
                              !bot.disabledMcpServerIds.some((id) => String(id) === serverId),
                          )
                          .map((bot) => ({ id: bot.id, name: bot.name })),
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
        ),
        ...(delegatedAccess && botId ? { billedBotId: botId } : {}),
        ...(delegationRuntime && botId
          ? {
              sendToUser: async (request) => {
                const active = sessions.get(key);
                const turnId = active?.activeTurn?.turnId;
                if (!turnId) throw new Error("User messaging requires an active turn.");
                return delegationRuntime!.sendToUser(
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
              delegation: delegationFor({ threadId, botId, parentDelegation, access, snapshot }),
            }
          : {}),
        ...(input.botId && channelRuntime
          ? {
              reactToMessage: (request, toolCallId) =>
                channelRuntime!.react(threadId, input.botId!, request, toolCallId),
              channels: {
                create: (request) => channelRuntime!.create(input.botId!, request),
                update: (request) => channelRuntime!.update(input.botId!, request),
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
            ...(input.cwd ? { projectPath: input.cwd } : {}),
            yolo: false,
            botConversation: resolved.botConversation,
            ...(input.botName ? { botName: input.botName } : {}),
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
          provider: resolved.provider,
          providerInstanceId: resolved.providerInstanceId,
          cwd: input.cwd,
          createdAt: nowIso(),
          mcpServerIds: mcpServers.map((server) => server.id),
          mcpServers,
          runtimeMode: access.runtimeMode,
          model: resolved.modelSelection.model,
          status: "ready" as const,
          activeTurn: null,
          admittingTurn: null,
          pendingTurns: [],
          toolNames: new Map<string, string>(),
          approvalRequests: new Map(),
          connectorSessionApprovals: new Set<string>(),
          toolSession,
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
          const { botUsage: _, ...providerInput } = input;
          return yield* legacyProviderBridge.sendTurn(
            resolved?.botConversation === true && String(resolved.provider) !== "claudeAgent"
              ? {
                  ...providerInput,
                  input: [AKERU_BOT_TURN_INSTRUCTIONS, providerInput.input]
                    .filter(Boolean)
                    .join("\n\n"),
                }
              : providerInput,
          );
        }
        if (input.timezone !== undefined) {
          active.toolSession = { ...active.toolSession, timezone: input.timezone };
          toolRuntime.registerSession(key, active.toolSession);
        }
        const attachmentFiles = yield* Effect.forEach(input.attachments ?? [], (attachment) => {
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
          return Effect.try({
            try: () => ({
              file: {
                data: NodeFS.readFileSync(path).toString("base64"),
                mediaType: attachment.mimeType,
                filename: attachment.name,
              },
              pathLine: `[Attached ${attachment.type} "${attachment.name}" is saved at: ${path}]`,
            }),
            catch: (cause) =>
              new AgentControllerRuntimeError({
                operation: "sendTurn.attachments",
                detail: `Could not read attachment '${attachment.id}'.`,
                cause,
              }),
          });
        });
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
        return yield* legacyProviderBridge.interruptTurn(input);
      }
      active.pendingTurns.length = 0;
      active.admittingTurn = null;
      active.session.abort();
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
            detail: `Stale pending approval request: ${input.requestId}. The agent session restarted. Send the request again.`,
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
          detail: `Stale pending approval request: ${input.requestId}. The agent turn has ended. Send the request again.`,
        });
      }
      const toolCallId = String(input.requestId);
      const routineRequest = pendingRoutineRequests.get(toolCallId);
      if (routineRequest) {
        pendingRoutineRequests.delete(toolCallId);
        if (active.activeTurn) active.activeTurn.waiting = false;
        publish({
          ...baseEvent(input.threadId, active, active.activeTurn?.turnId),
          requestId: RuntimeRequestId.make(toolCallId),
          type: "request.resolved",
          payload: { requestType: "dynamic_tool_call" as const, decision: input.decision },
        });
        publishSessionState(input.threadId, active, "running");
        if (input.decision === "decline" || input.decision === "cancel") {
          routineRequest.resolve({ status: "cancelled" });
          return;
        }
        const result = yield* routineDispatcher!
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
            Effect.tapError((cause) =>
              Effect.sync(() => {
                routineRequest.reject(cause);
              }),
            ),
          );
        routineRequest.resolve(result);
        return;
      }
      const toolRequest = active.approvalRequests.get(toolCallId);
      const pendingApproval = active.pendingApprovals.get(toolCallId);
      if (!toolRequest || !pendingApproval) return;
      const { name: toolName, input: toolInput } = toolRequest;
      const akeruTool = AKERU_TOOL_CATALOG.find((tool) => tool.id === toolName);
      const runtimeToolId = akeruTool?.id ?? (isMemoryToolId(toolName) ? toolName : undefined);
      const acceptForSession =
        input.decision === "acceptForSession" &&
        !runtimeToolId &&
        !isCodexComputerUseTool(toolName) &&
        !akeruActionNeedsApproval(toolName, toolInput) &&
        toolName !== AKERU_PRODUCT_FEEDBACK_TOOL_NAME;
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
          const update = acceptForSession
            ? active.session.permissions.setForTool({ toolName, policy: "allow" })
            : undefined;
          if (acceptForSession) active.connectorSessionApprovals.add(toolName);
          if (active.activeTurn) active.activeTurn.waiting = false;
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
          detail: `Stale pending approval request: ${input.requestId}. The agent turn has ended. Send the request again.`,
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
      publishSessionState(input.threadId, active, "running");
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
            detail: `Unknown pending user-input request: ${input.requestId}. The agent session restarted. Send the request again.`,
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
            if (active.activeTurn) active.activeTurn.waiting = false;
            return {
              _tag: "Dispatched" as const,
              resume: active.session.respondToToolSuspension({ toolCallId, resumeData: answer }),
            };
          },
        );
        if (admitted._tag === "Stale") {
          return yield* new AgentControllerRuntimeError({
            operation: "respondToUserInput",
            detail: `Unknown pending user-input request: ${input.requestId}. The agent turn has ended. Send the request again.`,
          });
        }
        yield* runMastra("respondToToolSuspension", () => admitted.resume);
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
      publishSessionState(input.threadId, active, "running");
    });

    const stopSessionWithResources = Effect.fn("AgentController.stopSession")(function* (
      input: Parameters<AgentControllerShape["stopSession"]>[0],
      destroyResources: boolean,
    ) {
      const key = String(input.threadId);
      const active = sessions.get(key);
      if (!active) {
        const legacySessions = yield* legacyProviderBridge.listSessions();
        if (legacySessions.some((session) => session.threadId === input.threadId)) {
          yield* legacyProviderBridge.stopSession(input).pipe(
            Effect.ensuring(
              Effect.gen(function* () {
                yield* runMastra("resources.release", () =>
                  sessionResources.release(key, { destroy: destroyResources }),
                ).pipe(Effect.ignoreCause({ log: true }));
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
      active.pendingTurns.length = 0;
      active.admittingTurn = null;
      active.session.abort();
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
          }),
        ),
      );
    });

    const stopSession: AgentControllerShape["stopSession"] = (input) =>
      stopSessionWithResources(input, false);

    const rollbackConversation: AgentControllerShape["rollbackConversation"] = (input) => {
      const resolved = resolvedByThread.get(String(input.threadId));
      if (!sessions.has(String(input.threadId)) && !resolved) {
        return legacyProviderBridge.rollbackConversation(input);
      }
      if (resolved && !usesMastraCode(resolved.provider)) {
        return legacyProviderBridge.rollbackConversation(input);
      }
      return Effect.fail(
        new AgentControllerRuntimeError({
          operation: "rollbackConversation",
          detail: `Mastra conversation rollback is not available for thread '${input.threadId}'.`,
        }),
      );
    };

    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        for (const [threadId, active] of sessions) {
          active.pendingTurns.length = 0;
          active.admittingTurn = null;
          active.session.abort();
          if (active.activeTurn) {
            finishTurn(ThreadId.make(threadId), active, "interrupted");
          }
          active.unsubscribe();
          yield* runMastra("deleteSession", () =>
            bundle.controller.deleteSession({ resourceId: threadId }),
          ).pipe(Effect.ignoreCause({ log: true }));
          yield* clearPreviewMcpSession(ThreadId.make(threadId));
          toolRuntime.unregisterSession(threadId);
        }
        legacyResourceIdentity.clear();
        sessions.clear();
        for (const waiter of childWaiters.values()) {
          if (waiter.timer) clearTimeout(waiter.timer);
          waiter.reject(new Error("The agent controller stopped."));
        }
        childWaiters.clear();
        yield* runMastra("resources.shutdown", () => sessionResources.shutdown()).pipe(
          Effect.ignoreCause({ log: true }),
        );
        yield* runMastra("destroy", () => bundle.controller.destroy()).pipe(
          Effect.ignoreCause({ log: true }),
        );
        yield* runMastra("bundle.destroy", async () => bundle.destroy()).pipe(
          Effect.ignoreCause({ log: true }),
        );
      }),
    );

    return AgentController.of({
      configurePluginRuntime: (input: AkeruPluginRuntimeOptions) =>
        Effect.sync(() => {
          pluginRuntimeOptions = input;
          pluginRuntime = createAkeruPluginRuntime(input);
        }),
      configureDelegation: (input) =>
        Effect.sync(() => {
          botStateRuntime = createAkeruBotStateRuntime(input);
          channelRuntime = createAkeruChannelRuntime(input);
          delegationRuntime ??= makeDelegationRuntime(input);
        }),
      failDelegation: ({ threadId, error }) =>
        Effect.sync(() => resolveChildWaiter(threadId, { state: "failed", turnId: null, error })),
      authenticateMcpServer: ({ server, onAuthorizationUrl }) =>
        Effect.tryPromise({
          try: async (signal) => {
            const status = await authenticateMcpServer({
              server,
              managers: sessionResources.getMcpManagersForServer(String(server.id)),
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
                void runPromise(
                  Effect.logWarning("MCP session recovery failed after authentication.", {
                    serverId,
                    error: message,
                  }),
                );
              },
            });
            return { toolCount: status.toolCount };
          },
          catch: (cause) =>
            new AgentControllerRuntimeError({
              operation: "mcp.authenticate",
              detail: failureDetail(cause),
              cause,
            }),
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
          Stream.tap((event) =>
            Effect.sync(() => {
              recordProviderAccessHealth(subscriptionAuth, event);
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
    const memoryCandidateRepository = yield* MemoryCandidateRepository;
    return yield* make({ entityMemoryRepository, memoryCandidateRepository });
  }),
);
