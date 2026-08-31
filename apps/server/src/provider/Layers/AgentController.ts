// @effect-diagnostics globalDate:off globalConsole:off globalRandom:off nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { AuthStorage } from "@mastra/code-sdk/auth/storage";
import {
  createMcpManager,
  type McpManager,
  type McpServerConfig,
} from "@mastra/code-sdk/mcp/index";
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
  type McpServer,
  type ModelSelection,
  type ProviderApprovalDecision,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type RuntimeMode,
  type ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import {
  SubscriptionAuthService,
  type SubscriptionProviderId,
} from "../../subscription-auth/service.ts";
import {
  akeruActionNeedsApproval,
  akeruToolCategory,
  criticalAkeruAction,
  createAkeruMastraHarness,
  type AkeruCriticalAction,
  type AkeruMastraHarness,
  type AkeruMastraHarnessOptions,
  type AkeruMastraSession,
  type AkeruToolCategory,
} from "../AkeruMastraHarness.ts";
import { createBotWorkspace, type CreateRemoteBotWorkspaceInput } from "../botWorkspace.ts";
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
  readonly pendingApprovals: Map<string, PendingApproval>;
  readonly unsubscribe: () => void;
}

interface PendingApproval {
  readonly toolName: string;
  readonly args: unknown;
  readonly action: AkeruCriticalAction | "unclassified";
  readonly serverId?: string;
  readonly pluginId?: string;
}

export interface AgentControllerLiveOptions {
  readonly makeMastraHarness?: (options: AkeruMastraHarnessOptions) => Promise<AkeruMastraHarness>;
  readonly makeMcpManager?: typeof createMcpManager;
  readonly makeRemoteWorkspace?: (input: CreateRemoteBotWorkspaceInput) => Promise<Workspace>;
}

export function createAkeruMastraAuthStorage(secretsDir: string): AuthStorage {
  return new AuthStorage(NodePath.join(secretsDir, "subscription-auth.json"));
}

function failureDetail(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
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

function mastraModelId(provider: ProviderDriverKind, model: string): string {
  switch (String(provider)) {
    case "codex":
      return `openai/${model}`;
    case "claudeAgent":
      return `anthropic/${model}`;
    case "grok":
      return `xai/${model}`;
    default:
      return model.includes("/") ? model : `${provider}/${model}`;
  }
}

export function toMcpServerConfigs(servers: readonly McpServer[]): Record<string, McpServerConfig> {
  return Object.fromEntries(
    servers.map((server) => [
      String(server.id),
      server.transport === "url"
        ? { url: server.url }
        : { command: server.command, ...(server.args ? { args: [...server.args] } : {}) },
    ]),
  );
}

function permissionPolicy(runtimeMode: RuntimeMode, category: AkeruToolCategory): "allow" | "ask" {
  if (runtimeMode === "full-access" || runtimeMode === "auto") return "allow";
  if (category === "read") return "allow";
  if (runtimeMode === "auto-accept-edits" && category === "edit") return "allow";
  return "ask";
}

function approvalDetail(toolName: string, oneUseApproval: boolean): string {
  return oneUseApproval
    ? `Allow ${toolName}? This approval applies only to the pending action. It does not undo completed work.`
    : `Allow ${toolName}?`;
}

function mcpAttribution(
  active: Pick<ActiveSession, "mcpServerIds">,
  toolName: string,
): { readonly serverId: string; readonly pluginId?: string } | undefined {
  const serverId = active.mcpServerIds
    .map(String)
    .toSorted((left, right) => right.length - left.length)
    .find((candidate) => toolName.startsWith(`${candidate}_`));
  if (!serverId) return undefined;
  return {
    serverId,
    ...(serverId.startsWith("builtin-") ? { pluginId: serverId.slice("builtin-".length) } : {}),
  };
}

function usesMastraCode(provider: ProviderDriverKind): boolean {
  return String(provider) === "codex";
}

function subscriptionProviderForRuntime(
  provider: ProviderDriverKind,
  providerInstanceId: ProviderInstanceId | undefined,
): SubscriptionProviderId | undefined {
  const instanceId = String(providerInstanceId);
  if (String(provider) === "codex" && instanceId === "codex") return "openai-codex";
  if (String(provider) === "claudeAgent" && instanceId === "claudeAgent") return "anthropic";
  if (String(provider) === "cursor" && instanceId === "cursor") return "cursor";
  if (String(provider) === "grok" && instanceId === "grok") return "xai";
  if (String(provider) === "opencode" && instanceId === "kimi-for-coding") {
    return "kimi-for-coding";
  }
  return undefined;
}

export function recordProviderAccessHealth(
  subscriptionAuth: SubscriptionAuthService,
  event: ProviderRuntimeEvent,
): void {
  const provider = subscriptionProviderForRuntime(event.provider, event.providerInstanceId);
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
    const mcpManagers = new Map<string, McpManager>();
    const workspaces = new Map<string, Workspace>();
    const makeMastraHarness = options?.makeMastraHarness ?? createAkeruMastraHarness;
    const bundle = yield* runMastra("construct", () =>
      makeMastraHarness({
        authStorage,
        getThreadTools: (threadId) => mcpManagers.get(threadId)?.getTools() ?? {},
        getThreadWorkspace: (threadId) => workspaces.get(threadId),
      }),
    );
    yield* runMastra("init", () => bundle.controller.init());

    const disconnectMcpManager = (key: string) => {
      const manager = mcpManagers.get(key);
      if (!manager) return Effect.void;
      mcpManagers.delete(key);
      return runMastra("mcp.disconnect", () => manager.disconnect()).pipe(
        Effect.ignoreCause({ log: true }),
      );
    };

    const disconnectWorkspace = (key: string) => {
      const workspace = workspaces.get(key);
      if (!workspace) return Effect.void;
      workspaces.delete(key);
      return runMastra("workspace.destroy", () => workspace.destroy()).pipe(
        Effect.ignoreCause({ log: true }),
      );
    };

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
              title: event.toolName,
              data: { args: event.args },
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
              data: { partialResult: event.partialResult },
            },
          });
          return;
        case "tool_end": {
          if (!turn) return;
          const toolName = active.toolNames.get(event.toolCallId) ?? "tool";
          const mcp = mcpAttribution(active, toolName);
          if (mcp && !event.denied) {
            if (event.isError) {
              subscriptionAuth.recordMcpRequestFailure(
                mcp.serverId,
                typeof event.result === "string" && event.result.trim().length > 0
                  ? event.result
                  : "The MCP request failed.",
              );
            } else {
              subscriptionAuth.recordMcpRequestSuccess(mcp.serverId);
            }
          }
          active.pendingApprovals.delete(event.toolCallId);
          publish({
            ...baseEvent(threadId, active, turn.turnId),
            itemId: RuntimeItemId.make(event.toolCallId),
            type: "item.completed",
            payload: {
              itemType: itemType(toolName),
              status: event.isError ? "failed" : event.denied ? "declined" : "completed",
              title: toolName,
              data: { result: event.result },
            },
          });
          return;
        }
        case "tool_approval_required": {
          if (!turn) return;
          active.toolNames.set(event.toolCallId, event.toolName);
          const mcp = mcpAttribution(active, event.toolName);
          const action = criticalAkeruAction(event.toolName, event.args);
          const oneUseApproval =
            mcp !== undefined || akeruActionNeedsApproval(event.toolName, event.args);
          if (
            !oneUseApproval &&
            permissionPolicy(active.runtimeMode, akeruToolCategory(event.toolName)) === "allow"
          ) {
            active.session.respondToToolApproval({
              toolCallId: event.toolCallId,
              decision: "approve",
            });
            return;
          }
          active.pendingApprovals.set(event.toolCallId, {
            toolName: event.toolName,
            args: event.args,
            action: action ?? "unclassified",
            ...mcp,
          });
          turn.waiting = true;
          publishSessionState(threadId, active, "waiting");
          publish({
            ...baseEvent(threadId, active, turn.turnId),
            requestId: RuntimeRequestId.make(event.toolCallId),
            type: "request.opened",
            payload: {
              requestType: "dynamic_tool_call",
              detail: approvalDetail(event.toolName, oneUseApproval),
              args: event.args,
              toolName: event.toolName,
              action: action ?? "unclassified",
              ...mcp,
              options: [
                { decision: "decline", label: "Decline" },
                { decision: "accept", label: oneUseApproval ? "Approve" : "Allow" },
              ],
            },
          });
          return;
        }
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
        case "error":
          publish({
            ...baseEvent(threadId, active, turn?.turnId),
            type: "runtime.error",
            payload: {
              message: event.error.message || "Mastra agent failed.",
              class: "provider_error",
            },
          });
          finishTurn(threadId, active, "failed", event.error.message || "Mastra agent failed.");
          return;
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
      const existing = sessions.get(key);
      if (existing) return toProviderSession(threadId, existing);
      const resolved = resolvedByThread.get(key);
      if (!resolved) {
        return yield* new AgentControllerRuntimeError({
          operation: "startSession",
          detail: `Thread '${threadId}' has no resolved engine.`,
        });
      }
      if (!usesMastraCode(resolved.provider)) {
        return yield* legacyProviderBridge.startSession(threadId, input);
      }
      const mcpServers = input.mcpServers ?? [];
      if (mcpServers.length > 0) {
        const manager = (options?.makeMcpManager ?? createMcpManager)(
          NodePath.join(config.stateDir, "bot-mcp-runtime"),
          ".akeru-runtime",
          toMcpServerConfigs(mcpServers),
        );
        yield* runMastra("mcp.init", () => manager.init());
        for (const status of manager.getServerStatuses()) {
          if (!status.connected) {
            subscriptionAuth.recordMcpRequestFailure(
              status.name,
              status.error ?? "The MCP server failed to connect.",
            );
          }
        }
        mcpManagers.set(key, manager);
      }
      const workspace = yield* runMastra("workspace.create", () =>
        createBotWorkspace({
          threadId: key,
          ...(input.cwd ? { cwd: input.cwd } : {}),
          ...(input.botSandbox !== undefined ? { sandbox: input.botSandbox } : {}),
          ...(options?.makeRemoteWorkspace
            ? { makeRemoteWorkspace: options.makeRemoteWorkspace }
            : {}),
        }),
      );
      if (workspace) workspaces.set(key, workspace);
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
          Effect.all([disconnectMcpManager(key), disconnectWorkspace(key)], { discard: true }),
        ),
      );
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
            session.permissions.setForCategory({ category, policy: "ask" }),
          ),
        { discard: true },
      );
      const createdAt = nowIso();
      const activeWithoutUnsubscribe = {
        session,
        provider: resolved.provider,
        providerInstanceId: resolved.providerInstanceId,
        cwd: input.cwd,
        createdAt,
        mcpServerIds: mcpServers.map((server) => server.id),
        runtimeMode: input.runtimeMode,
        model: resolved.modelSelection.model,
        status: "ready" as const,
        activeTurn: null,
        toolNames: new Map<string, string>(),
        pendingApprovals: new Map<string, PendingApproval>(),
      };
      const unsubscribe = session.subscribe((event) => {
        const active = sessions.get(key);
        if (active) handleControllerEvent(threadId, active, event);
      });
      const active: ActiveSession = { ...activeWithoutUnsubscribe, unsubscribe };
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
            const detail = failureDetail(cause);
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
      const toolCallId = String(input.requestId);
      if (!active.pendingApprovals.delete(toolCallId)) return;
      const decision =
        input.decision === "acceptForSession" || input.decision === "acceptAlways"
          ? "accept"
          : input.decision;
      if (active.activeTurn) active.activeTurn.waiting = false;
      active.session.respondToToolApproval({
        toolCallId,
        decision: approvalDecision(decision),
      });
      publish({
        ...baseEvent(input.threadId, active, active.activeTurn?.turnId),
        requestId: RuntimeRequestId.make(toolCallId),
        type: "request.resolved",
        payload: { requestType: "dynamic_tool_call" as const, decision },
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

    const stopSession: AgentControllerShape["stopSession"] = Effect.fn(
      "AgentController.stopSession",
    )(function* (input) {
      const key = String(input.threadId);
      const active = sessions.get(key);
      if (!active) {
        const legacySessions = yield* legacyProviderBridge.listSessions();
        if (legacySessions.some((session) => session.threadId === input.threadId)) {
          return yield* legacyProviderBridge.stopSession(input);
        }
        if (
          usesMastraCode(resolvedByThread.get(key)?.provider ?? ProviderDriverKind.make("codex"))
        ) {
          return;
        }
        return yield* legacyProviderBridge.stopSession(input);
      }
      active.session.abort();
      active.unsubscribe();
      publishSessionState(input.threadId, active, "stopped");
      yield* runMastra("deleteSession", () => bundle.controller.deleteSession({ resourceId: key }));
      yield* disconnectMcpManager(key);
      yield* disconnectWorkspace(key);
      sessions.delete(key);
    });

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
          yield* disconnectMcpManager(threadId);
          yield* disconnectWorkspace(threadId);
        }
        sessions.clear();
        bundle.destroy();
        yield* runMastra("destroy", () => bundle.controller.destroy()).pipe(
          Effect.ignoreCause({ log: true }),
        );
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

function approvalDecision(
  decision: ProviderApprovalDecision,
): "approve" | "decline" | "always_allow_category" {
  if (decision === "decline" || decision === "cancel") return "decline";
  if (decision === "acceptAlways") return "always_allow_category";
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
