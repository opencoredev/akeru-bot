// @effect-diagnostics globalDate:off globalConsole:off globalRandom:off nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { AuthStorage } from "@mastra/code-sdk/auth/storage";
import { createMcpManager, type McpServerConfig } from "@mastra/code-sdk/mcp/index";
import type {
  AgentControllerEvent,
  MastraDBMessage,
  MastraMessagePart,
} from "@mastra/core/agent-controller";
import { Workspace } from "@mastra/core/workspace";
import {
  EventId,
  ProviderDriverKind,
  ProviderInstanceId,
  RuntimeItemId,
  RuntimeRequestId,
  TurnId,
  AKERU_TOOL_CATALOG,
  DEFAULT_BOT_SANDBOX_BROWSER_SHARING,
  type McpServer,
  type ModelSelection,
  type ProviderApprovalDecision,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type RuntimeMode,
  type ThreadId,
  AKERU_PRODUCT_FEEDBACK_TOOL_NAME,
} from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { BotInboxService } from "../../bot-inbox/service.ts";
import { recordUserActionIncident } from "../../bot-inbox/userActionIncidents.ts";
import { ServerConfig } from "../../config.ts";
import {
  SubscriptionAuthService,
  type SubscriptionProviderId,
} from "../../subscription-auth/service.ts";
import {
  akeruActionNeedsApproval,
  createAkeruMastraHarness,
  mastraModelId,
  type AkeruMastraHarness,
  type AkeruMastraHarnessOptions,
  type AkeruMastraSession,
} from "../AkeruMastraHarness.ts";
import { createAkeruToolRuntime, type AkeruToolSession } from "../AkeruToolRuntime.ts";
import type { BotBrowser, BotBrowserAttachment, CreateBotBrowserInput } from "../botBrowser.ts";
import { AkeruSessionResources } from "../AkeruSessionResources.ts";
import {
  isCodexComputerUseServer,
  isCodexComputerUseTool,
  resolveCodexComputerUseServer,
} from "../CodexComputerUse.ts";
import type { CreateRemoteBotWorkspaceInput } from "../botWorkspace.ts";
import {
  botRuntimeResourceScope,
  botWorkspaceIdentity,
  botWorkspaceResourceKey,
} from "../botWorkspacePool.ts";
import { AgentControllerRuntimeError, AgentControllerUnsupportedEngineError } from "../Errors.ts";
import { AgentController, type AgentControllerShape } from "../Services/AgentController.ts";
import { LegacyProviderBridge } from "../Services/LegacyProviderBridge.ts";

const DEFAULT_MODE_ID = "build";
const PLAN_MODE_ID = "plan";
type MastraSession = AkeruMastraSession;

interface ResolvedEngine {
  readonly modelSelection: ModelSelection;
  readonly provider: ProviderDriverKind;
  readonly providerInstanceId: ProviderInstanceId;
  readonly mastraModelId: string;
  readonly mode: "default" | "plan";
}

interface ActiveTurn {
  readonly turnId: TurnId;
  readonly assistantItemId: RuntimeItemId;
  assistantLength: number;
  assistantStarted: boolean;
  assistantCompleted: boolean;
  waiting: boolean;
  finished: boolean;
}

interface ActiveSession {
  readonly session: MastraSession;
  readonly provider: ProviderDriverKind;
  readonly providerInstanceId: ProviderInstanceId;
  readonly cwd: string | undefined;
  readonly createdAt: string;
  readonly mcpServerIds: readonly McpServer["id"][];
  runtimeMode: RuntimeMode;
  model: string;
  status: ProviderSession["status"];
  activeTurn: ActiveTurn | null;
  readonly toolNames: Map<string, string>;
  readonly approvalRequests: Map<string, { readonly name: string; readonly input: unknown }>;
  readonly connectorSessionApprovals: Set<string>;
  toolSession: AkeruToolSession;
  readonly workspaceResourceKey: string;
  readonly unsubscribe: () => void;
}

export interface AgentControllerLiveOptions {
  readonly makeMastraHarness?: (options: AkeruMastraHarnessOptions) => Promise<AkeruMastraHarness>;
  readonly makeMcpManager?: typeof createMcpManager;
  readonly makeRemoteWorkspace?: (input: CreateRemoteBotWorkspaceInput) => Promise<Workspace>;
  readonly makeBotBrowser?: (input: CreateBotBrowserInput) => BotBrowser;
  readonly resolveComputerUseServer?: typeof resolveCodexComputerUseServer;
}

export function createAkeruMastraAuthStorage(secretsDir: string): AuthStorage {
  return new AuthStorage(NodePath.join(secretsDir, "subscription-auth.json"));
}

function failureDetail(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
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

function permissionPolicy(
  runtimeMode: RuntimeMode,
  category: "read" | "edit" | "execute" | "mcp" | "other",
): "allow" | "ask" {
  if (runtimeMode === "full-access" || runtimeMode === "auto") return "allow";
  if (category === "read") return "allow";
  if (runtimeMode === "auto-accept-edits" && category === "edit") return "allow";
  return "ask";
}

function usesMastraCode(provider: ProviderDriverKind): boolean {
  return provider === "codex" || provider === "kimi";
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
    const mutationLock = yield* Semaphore.make(1);
    const runtimeEvents = yield* PubSub.unbounded<ProviderRuntimeEvent>();
    const resolvedByThread = new Map<string, ResolvedEngine>();
    const sessions = new Map<string, ActiveSession>();

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
      toMcpServerConfigs,
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
    });
    const legacyResourceIdentity = new Map<
      string,
      {
        readonly workspaceResourceKey: string;
        readonly cwd: string | undefined;
        readonly provider: ProviderDriverKind;
        readonly providerInstanceId: ProviderInstanceId;
      }
    >();
    const makeMastraHarness = options?.makeMastraHarness ?? createAkeruMastraHarness;
    const bundle = yield* runMastra("construct", () =>
      makeMastraHarness({
        authStorage,
        getKimiAccess: () => subscriptionAuth.getKimiForCodingAccess(),
        syncThreadToolApproval: async (threadId, toolName, protectedAction) => {
          const active = sessions.get(threadId);
          if (!active || (!protectedAction && !active.connectorSessionApprovals.has(toolName))) {
            return;
          }
          await active.session.permissions.setForTool({
            toolName,
            policy: protectedAction ? "ask" : "allow",
          });
        },
        getThreadTools: (threadId) => sessionResources.getConnectorTools(threadId),
        toolRuntime,
      }),
    );
    yield* runMastra("init", () => bundle.controller.init());

    const publish = (event: ProviderRuntimeEvent) => {
      PubSub.publishUnsafe(runtimeEvents, event);
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

    const finishTurn = (
      threadId: ThreadId,
      active: ActiveSession,
      state: "completed" | "failed" | "interrupted",
      errorMessage?: string,
    ) => {
      const turn = active.activeTurn;
      if (!turn || turn.finished) return;
      turn.finished = true;
      if (turn.assistantStarted && !turn.assistantCompleted) {
        turn.assistantCompleted = true;
        publish({
          ...baseEvent(threadId, active, turn.turnId),
          itemId: turn.assistantItemId,
          type: "item.completed",
          payload: { itemType: "assistant_message", status: "completed" },
        });
      }
      publish({
        ...baseEvent(threadId, active, turn.turnId),
        type: "turn.completed",
        payload: {
          state,
          ...(errorMessage ? { errorMessage } : {}),
        },
      });
      active.approvalRequests.clear();
      toolRuntime.clearApprovals(String(threadId));
      active.activeTurn = null;
      publishSessionState(threadId, active, "ready");
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
      if (!turn.assistantStarted && text.length > 0) {
        turn.assistantStarted = true;
        publish({
          ...baseEvent(threadId, active, turn.turnId),
          itemId: turn.assistantItemId,
          type: "item.started",
          payload: { itemType: "assistant_message", status: "inProgress" },
        });
      }
      if (text.length > turn.assistantLength) {
        const delta = text.slice(turn.assistantLength);
        turn.assistantLength = text.length;
        publish({
          ...baseEvent(threadId, active, turn.turnId),
          itemId: turn.assistantItemId,
          type: "content.delta",
          payload: { streamKind: "assistant_text", delta },
        });
      }
      if (complete && turn.assistantStarted && !turn.assistantCompleted) {
        turn.assistantCompleted = true;
        publish({
          ...baseEvent(threadId, active, turn.turnId),
          itemId: turn.assistantItemId,
          type: "item.completed",
          payload: { itemType: "assistant_message", status: "completed" },
        });
      }
    };

    const handleControllerEvent = (
      threadId: ThreadId,
      active: ActiveSession,
      event: AgentControllerEvent,
    ) => {
      const turn = active.activeTurn;
      switch (event.type) {
        case "message_update":
          publishAssistantText(threadId, active, event.message, false);
          return;
        case "message_end":
          publishAssistantText(threadId, active, event.message, true);
          return;
        case "tool_start": {
          if (!turn) return;
          active.toolNames.set(event.toolCallId, event.toolName);
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
          active.approvalRequests.delete(event.toolCallId);
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
                : { result: event.result },
            },
          });
          return;
        }
        case "tool_approval_required":
          if (!turn) return;
          active.toolNames.set(event.toolCallId, event.toolName);
          active.approvalRequests.set(event.toolCallId, {
            name: event.toolName,
            input: event.args,
          });
          turn.waiting = true;
          publishSessionState(threadId, active, "waiting");
          publish({
            ...baseEvent(threadId, active, turn.turnId),
            requestId: RuntimeRequestId.make(event.toolCallId),
            type: "request.opened",
            payload: {
              requestType: "dynamic_tool_call",
              detail: isCodexComputerUseTool(event.toolName)
                ? "Allow Computer Use?"
                : event.toolName === AKERU_PRODUCT_FEEDBACK_TOOL_NAME
                  ? "Review product feedback"
                  : `Allow ${event.toolName}?`,
              toolName: isCodexComputerUseTool(event.toolName) ? "Computer Use" : event.toolName,
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
                  : AKERU_TOOL_CATALOG.some((tool) => tool.id === event.toolName) ||
                      akeruActionNeedsApproval(event.toolName, event.args)
                    ? [
                        { decision: "accept", label: "Allow" },
                        { decision: "decline", label: "Decline" },
                      ]
                    : [
                        { decision: "accept", label: "Allow" },
                        { decision: "acceptForSession", label: "Allow for session" },
                        { decision: "decline", label: "Decline" },
                      ],
            },
          });
          return;
        case "tool_suspended":
          if (!turn) return;
          active.toolNames.set(event.toolCallId, event.toolName);
          turn.waiting = true;
          publishSessionState(threadId, active, "waiting");
          publish({
            ...baseEvent(threadId, active, turn.turnId),
            requestId: RuntimeRequestId.make(event.toolCallId),
            type: "user-input.requested",
            payload: {
              questions: [
                {
                  id: event.toolCallId,
                  header: event.toolName,
                  question: `Input required for ${event.toolName}`,
                  options: [],
                  multiSelect: false,
                },
              ],
            },
          });
          return;
        case "usage_update":
          if (!turn) return;
          publish({
            ...baseEvent(threadId, active, turn.turnId),
            type: "thread.token-usage.updated",
            payload: {
              usage: {
                usedTokens: Math.max(0, event.usage.totalTokens ?? 0),
                inputTokens: Math.max(0, event.usage.promptTokens ?? 0),
                outputTokens: Math.max(0, event.usage.completionTokens ?? 0),
                reasoningOutputTokens: Math.max(0, event.usage.reasoningTokens ?? 0),
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
      const capabilities = yield* legacyProviderBridge
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
                };
          const inspected = yield* inspectEngine(modelSelection);
          const resolved: ResolvedEngine = {
            modelSelection,
            provider: inspected.routing.driverKind,
            providerInstanceId: modelSelection.instanceId,
            mastraModelId: mastraModelId(inspected.routing.driverKind, modelSelection.model),
            mode: input.mode,
          };
          resolvedByThread.set(String(input.threadId), resolved);
          const active = sessions.get(String(input.threadId));
          if (active && usesMastraCode(resolved.provider)) {
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
      const resourceScope = botRuntimeResourceScope({
        sharing: input.botSandboxBrowserSharing ?? DEFAULT_BOT_SANDBOX_BROWSER_SHARING,
        ...(input.botId ? { botId: input.botId } : {}),
        threadId: key,
      });
      const workspaceResourceKey = botWorkspaceResourceKey({
        resourceScope,
        ...(input.botSandbox !== undefined ? { sandbox: input.botSandbox } : {}),
      });
      const workspaceId = botWorkspaceIdentity(workspaceResourceKey);
      const existing = sessions.get(key);
      const resolved = resolvedByThread.get(key);
      const mcpServers = input.mcpServers ?? [];
      if (!resolved) {
        return yield* new AgentControllerRuntimeError({
          operation: "startSession",
          detail: `Thread '${threadId}' has no resolved engine.`,
        });
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
        resolved &&
        existing.provider === resolved.provider &&
        existing.providerInstanceId === resolved.providerInstanceId &&
        existing.mcpServerIds.length === (input.mcpServers?.length ?? 0) &&
        existing.mcpServerIds.every((id) => input.mcpServers?.some((server) => server.id === id))
      ) {
        existing.runtimeMode = input.runtimeMode;
        const toolSession = { ...existing.toolSession };
        delete toolSession.botId;
        delete toolSession.botName;
        existing.toolSession = {
          ...toolSession,
          runtimeMode: input.runtimeMode,
          ...(input.botId ? { botId: input.botId } : {}),
          ...(input.botName ? { botName: input.botName } : {}),
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
      const resources = yield* runMastra("resources.acquire", () =>
        sessionResources.acquire({
          threadId: key,
          resourceScope,
          workspaceResourceKey,
          workspaceId,
          ...(input.botSandbox !== undefined ? { botSandbox: input.botSandbox } : {}),
          ...(input.cwd ? { userComputerCwd: input.cwd } : {}),
          mcpServers,
        }),
      );
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
      const toolSession: AkeruToolSession = {
        ...(input.botId ? { botId: input.botId } : {}),
        ...(input.botName ? { botName: input.botName } : {}),
        runtimeMode: input.runtimeMode,
        workspaceType: resources.workspaceType,
        workspace: resources.workspace,
        ...(resources.userComputerWorkspace
          ? { userComputerWorkspace: resources.userComputerWorkspace }
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
          workspace: resources.workspace,
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
        yield* runMastra("state.set", () =>
          session.state.set({
            ...(input.cwd ? { projectPath: input.cwd } : {}),
            yolo: false,
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
                policy: permissionPolicy(input.runtimeMode, category),
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
          runtimeMode: input.runtimeMode,
          model: resolved.modelSelection.model,
          status: "ready" as const,
          activeTurn: null,
          toolNames: new Map<string, string>(),
          approvalRequests: new Map(),
          connectorSessionApprovals: new Set<string>(),
          toolSession,
          workspaceResourceKey,
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
        const active = sessions.get(key);
        if (!active) {
          if (resolvedByThread.get(key)?.provider === ProviderDriverKind.make("codex")) {
            return yield* new AgentControllerRuntimeError({
              operation: "sendTurn",
              detail: `Mastra session for thread '${input.threadId}' is not running.`,
            });
          }
          return yield* legacyProviderBridge.sendTurn(input);
        }
        if (active.activeTurn) {
          return yield* new AgentControllerRuntimeError({
            operation: "sendTurn",
            detail: `Mastra session for thread '${input.threadId}' already has an active turn.`,
          });
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
              pathLine: `[Attached image "${attachment.name}" is saved at: ${path}]`,
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
        active.activeTurn = {
          turnId,
          assistantItemId: RuntimeItemId.make(`mastra-answer-${turnId}`),
          assistantLength: 0,
          assistantStarted: false,
          assistantCompleted: false,
          waiting: false,
          finished: false,
        };
        active.status = "running";
        publish({
          ...baseEvent(input.threadId, active, turnId),
          type: "turn.started",
          payload: { model: active.model },
        });
        publishSessionState(input.threadId, active, "running");
        void active.session
          .sendMessage({ content, ...(files.length > 0 ? { files } : {}) })
          .then(() => {
            if (!active.activeTurn?.waiting) {
              finishTurn(input.threadId, active, "completed");
            }
          })
          .catch((cause: unknown) => {
            const detail = sessionFailureDetail(active, cause);
            publish({
              ...baseEvent(input.threadId, active, turnId),
              type: "runtime.error",
              payload: { message: detail, class: "provider_error" },
            });
            finishTurn(input.threadId, active, "failed", detail);
          });
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
          return;
        }
        return yield* legacyProviderBridge.respondToRequest(input);
      }
      if (!active.activeTurn) return;
      const toolCallId = String(input.requestId);
      const toolRequest = active.approvalRequests.get(toolCallId);
      if (!toolRequest) return;
      active.approvalRequests.delete(toolCallId);
      const { name: toolName, input: toolInput } = toolRequest;
      const akeruTool = AKERU_TOOL_CATALOG.find((tool) => tool.id === toolName);
      if (akeruTool && input.decision !== "decline" && input.decision !== "cancel") {
        toolRuntime.grantApproval({
          threadId: key,
          toolCallId,
          toolId: akeruTool.id,
          input: toolInput,
        });
      }
      if (
        input.decision === "acceptForSession" &&
        !akeruTool &&
        !isCodexComputerUseTool(toolName) &&
        !akeruActionNeedsApproval(toolName, toolInput) &&
        toolName !== AKERU_PRODUCT_FEEDBACK_TOOL_NAME
      ) {
        active.connectorSessionApprovals.add(toolName);
        yield* runMastra("permissions.setForTool", () =>
          active.session.permissions.setForTool({ toolName, policy: "allow" }),
        );
      }
      if (active.activeTurn) active.activeTurn.waiting = false;
      active.session.respondToToolApproval({
        toolCallId,
        decision:
          akeruTool && input.decision !== "decline" && input.decision !== "cancel"
            ? "approve"
            : approvalDecision(input.decision),
      });
      publish({
        ...baseEvent(input.threadId, active, active.activeTurn?.turnId),
        requestId: RuntimeRequestId.make(toolCallId),
        type: "request.resolved",
        payload: { requestType: "dynamic_tool_call" as const, decision: input.decision },
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
          return;
        }
        return yield* legacyProviderBridge.respondToUserInput(input);
      }
      const toolCallId = String(input.requestId);
      if (active.activeTurn) active.activeTurn.waiting = false;
      yield* runMastra("respondToToolSuspension", () =>
        active.session.respondToToolSuspension({ toolCallId, resumeData: input.answers }),
      );
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
          toolRuntime.unregisterSession(key);
          return;
        }
        return yield* legacyProviderBridge.stopSession(input);
      }
      active.session.abort();
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
            toolRuntime.unregisterSession(key);
            sessions.delete(key);
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
          active.session.abort();
          active.unsubscribe();
          yield* runMastra("deleteSession", () =>
            bundle.controller.deleteSession({ resourceId: threadId }),
          ).pipe(Effect.ignoreCause({ log: true }));
          toolRuntime.unregisterSession(threadId);
        }
        legacyResourceIdentity.clear();
        sessions.clear();
        yield* runMastra("resources.shutdown", () => sessionResources.shutdown()).pipe(
          Effect.ignoreCause({ log: true }),
        );
        yield* runMastra("destroy", () => bundle.controller.destroy()).pipe(
          Effect.ignoreCause({ log: true }),
        );
        bundle.destroy();
      }),
    );

    return AgentController.of({
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

export const AgentControllerLive = makeAgentControllerLive();
