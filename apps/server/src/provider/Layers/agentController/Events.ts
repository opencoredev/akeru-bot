import { readSdkRecord } from "../ProtocolJson.ts";
import * as Match from "effect/Match";
import { omitNullToolFields } from "./Policy.ts";
import * as Predicate from "effect/Predicate";
import type { McpManager } from "@mastra/code-sdk/mcp/index";
import { akeruToolCategory } from "../../AkeruMastraHarness.ts";
import type { AkeruToolRuntime } from "../../AkeruToolRuntime.ts";
import type { RuntimeMode } from "@akeru/contracts";
import type { AkeruRuntimeSeam } from "../../AkeruRuntimeSeam.ts";
import type { AgentControllerLiveOptions } from "./Options.ts";
// @effect-diagnostics globalDate:off globalConsole:off globalRandom:off nodeBuiltinImport:off globalTimers:off globalFetch:off

import type { AgentControllerEvent, MastraDBMessage } from "@mastra/core/agent-controller";

import {
  RuntimeItemId,
  RuntimeRequestId,
  TurnId,
  AKERU_TOOL_CATALOG,
  type ProviderRuntimeEvent,
  ThreadId,
  AKERU_PRODUCT_FEEDBACK_TOOL_NAME,
  AKERU_CREATE_ROUTINE_TOOL_NAME,
} from "@akeru/contracts";

import { ServerConfig } from "../../../config.ts";

import { persistAkeruPreviewSnapshot } from "../../AkeruPreviewSnapshotAttachment.ts";
import { SubscriptionAuthService } from "../../../subscription-auth/service.ts";
import { akeruActionNeedsApproval, criticalAkeruAction } from "../../AkeruMastraHarness.ts";

import { type AkeruChannelRuntime } from "../../AkeruChannelRuntime.ts";
import { type AkeruBotStateRuntime } from "../../AkeruBotStateRuntime.ts";

import type { AkeruWorkerRuntime } from "../../AkeruWorkerRuntime.ts";

import {
  createAkeruPluginRuntime,
  type AkeruPluginRuntimeOptions,
} from "../../AkeruCatalogToolHandlers.ts";

import { isMemoryToolId } from "../../AkeruToolRuntime.ts";

import { AkeruSessionResources } from "../../AkeruSessionResources.ts";

import { isCodexComputerUseTool } from "../../CodexComputerUse.ts";

import { LegacyProviderBridge } from "../../Services/LegacyProviderBridge.ts";

import {
  type ActiveAssistantMessage,
  type ActiveTurn,
  type ActiveSession,
  type PendingApproval,
  type WorkerOrchestration,
} from "./State.ts";

import { nowIso, eventId } from "./EventIdentity.ts";
import { mcpServerIdForToolName } from "./McpConfiguration.ts";

export function createEvents(deps: {
  readonly forkPromise: AkeruRuntimeSeam["forkPromise"];
  readonly runPromise: AkeruRuntimeSeam["runPromise"];
  readonly publish: (event: ProviderRuntimeEvent) => void;
  readonly messageText: (message: MastraDBMessage) => string;
  readonly itemType: (
    toolName: string,
  ) => "command_execution" | "file_change" | "mcp_tool_call" | "dynamic_tool_call";
  readonly config: ServerConfig["Service"];
  readonly subscriptionAuth: SubscriptionAuthService;
  readonly cancelPendingApproval: (
    threadId: ThreadId,
    active: ActiveSession,
    requestId: string,
    pending: PendingApproval,
  ) => void;
  readonly sessionResources: AkeruSessionResources;
  readonly APPROVAL_FREE_MASTRA_TOOL_NAMES: ReadonlySet<string>;
  readonly omitNullToolFields: typeof omitNullToolFields;
  readonly mcpToolNeedsApproval: (manager: McpManager | undefined, toolName: string) => boolean;
  readonly permissionPolicy: (
    runtimeMode: RuntimeMode,
    category: ReturnType<typeof akeruToolCategory>,
  ) => "allow" | "ask";
  readonly legacyProviderBridge: LegacyProviderBridge["Service"];
  readonly toolRuntime: AkeruToolRuntime;
  readonly failActiveTurn: (
    active: ActiveSession,
    threadId: ThreadId,
    turnId: TurnId,
    cause: unknown,
  ) => Promise<void>;
  readonly wired: () => {
    readonly channelRuntime?: AkeruChannelRuntime;
    readonly pluginRuntime?: ReturnType<typeof createAkeruPluginRuntime>;
    readonly pluginRuntimeOptions?: AkeruPluginRuntimeOptions;
    readonly botStateRuntime?: AkeruBotStateRuntime;
    readonly delegationRuntime?: AgentControllerLiveOptions["delegationRuntime"];
    readonly workerOrchestration?: WorkerOrchestration;
  };
  readonly workerRuntime: AkeruWorkerRuntime;
  readonly approvalDetail: (toolName: string, action: string | null, oneUse: boolean) => string;
  readonly sessionFailureDetail: (
    active: Pick<ActiveSession, "mcpServerIds">,
    cause: unknown,
  ) => string;
  readonly finishTurn: (
    threadId: ThreadId,
    active: ActiveSession,
    state: "completed" | "failed" | "interrupted",
    errorMessage?: string,
  ) => void;
}) {
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
    active.status = Match.value(state).pipe(
      Match.when("running", () => "running" as const),
      Match.when("error", () => "error" as const),
      Match.when("stopped", () => "closed" as const),
      Match.orElse(() => "ready" as const),
    );
    deps.publish({
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

    deps.publish({
      ...baseEvent(threadId, active, turn.turnId),
      itemId,
      type: "item.started",
      payload: { itemType: "assistant_message", status: "inProgress" },
    });
    deps.publish({
      ...baseEvent(threadId, active, turn.turnId),
      itemId,
      type: "content.delta",
      payload: { streamKind: "assistant_text", delta: text },
    });
    turn.assistantText += text;
    deps.publish({
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

  const publishAssistantText = (
    threadId: ThreadId,
    active: ActiveSession,
    message: MastraDBMessage,
    complete: boolean,
  ) => {
    if (message.role !== "assistant") return;
    const turn = active.activeTurn;

    if (!turn) return;
    const text = deps.messageText(message);
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
      deps.publish({
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
        deps.publish({
          ...baseEvent(threadId, active, turn.turnId),
          itemId: RuntimeItemId.make(event.toolCallId),
          type: "item.started",
          payload: {
            itemType: deps.itemType(event.toolName),
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
        deps.publish({
          ...baseEvent(threadId, active, turn.turnId),
          itemId: RuntimeItemId.make(event.toolCallId),
          type: "item.updated",
          payload: {
            itemType: deps.itemType(active.toolNames.get(event.toolCallId) ?? "tool"),
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
                attachmentsDir: deps.config.attachmentsDir,
                threadId: String(threadId),
                result: event.result,
              })
            : null;

        active.approvalRequests.delete(event.toolCallId);
        active.toolNames.delete(event.toolCallId);
        const mcpServerId = mcpServerIdForToolName(active.mcpServerIds, toolName);

        if (mcpServerId && !event.denied) {
          if (event.isError) {
            deps.subscriptionAuth.recordMcpRequestFailure(
              mcpServerId,
              "The MCP tool request failed.",
            );
          } else {
            deps.subscriptionAuth.recordMcpRequestSuccess(mcpServerId);
          }
        }

        publishToolReceipt(
          event.toolCallId,
          toolName,
          event.isError || event.denied ? "failure" : "success",
        );
        const pending = active.pendingApprovals.get(event.toolCallId);

        if (pending) {
          deps.cancelPendingApproval(threadId, active, event.toolCallId, pending);
          active.pendingApprovals.delete(event.toolCallId);
        }

        deps.publish({
          ...baseEvent(threadId, active, turn.turnId),
          itemId: RuntimeItemId.make(event.toolCallId),
          type: "item.completed",
          payload: {
            itemType: deps.itemType(toolName),
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
        const mcpManager = deps.sessionResources.getMcpManager(String(threadId));
        const connectorTools = mcpManager?.getTools();

        if (
          deps.APPROVAL_FREE_MASTRA_TOOL_NAMES.has(event.toolName) &&
          (!connectorTools || !Object.hasOwn(connectorTools, event.toolName))
        ) {
          active.session.respondToToolApproval({
            toolCallId: event.toolCallId,
            decision: "approve",
          });

          return;
        }

        const toolInput = deps.omitNullToolFields(event.args);
        const action = criticalAkeruAction(event.toolName, toolInput);

        const oneUseApproval =
          akeruActionNeedsApproval(event.toolName, toolInput) ||
          deps.mcpToolNeedsApproval(mcpManager, event.toolName);

        if (
          event.toolName !== AKERU_PRODUCT_FEEDBACK_TOOL_NAME &&
          !oneUseApproval &&
          deps.permissionPolicy(active.runtimeMode, akeruToolCategory(event.toolName)) === "allow"
        ) {
          deps.forkPromise(
            "Akeru could not approve an allowed tool call.",
            () =>
              deps.runPromise(
                deps.legacyProviderBridge.dispatchIfEnabled(
                  active.providerInstanceId,
                  "AgentController.handleControllerEvent",
                  () => {
                    if (active.activeTurn !== turn || turn.finished) return;

                    // Akeru runtime tools check their own grant before running.
                    const runtimeToolId =
                      AKERU_TOOL_CATALOG.find((tool) => tool.id === event.toolName)?.id ??
                      (isMemoryToolId(event.toolName) ? event.toolName : undefined);

                    if (runtimeToolId) {
                      deps.toolRuntime.grantApproval({
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

                return deps.failActiveTurn(active, threadId, turn.turnId, cause);
              },
            },
          );

          return;
        }

        // The session's own grant covers a worker chat a restart orphaned, which the
        // runtimes no longer track.
        const grant =
          deps.wired().delegationRuntime?.accessForThread(threadId) ??
          deps.workerRuntime.accessForThread(threadId) ??
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
        deps.publish({
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
                  : deps.approvalDetail(event.toolName, action, oneUseApproval),
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

        const suspendPayload = readSdkRecord(event.suspendPayload) ?? {};

        const question =
          Predicate.isString(suspendPayload.question) && suspendPayload.question.trim()
            ? suspendPayload.question.trim()
            : `Input required for ${event.toolName}`;

        const options = Array.isArray(suspendPayload.options)
          ? suspendPayload.options.flatMap((option) => {
              const value = readSdkRecord(option);

              if (!value) return [];

              if (!Predicate.isString(value.label) || !value.label.trim()) return [];
              const label = value.label.trim();

              return [
                {
                  label,
                  description:
                    Predicate.isString(value.description) && value.description.trim()
                      ? value.description.trim()
                      : label,
                },
              ];
            })
          : [];

        deps.publish({
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
        deps.publish({
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
        const detail = deps.sessionFailureDetail(active, event.error);
        deps.publish({
          ...baseEvent(threadId, active, turn?.turnId),
          type: "runtime.error",
          payload: {
            message: detail,
            class: "provider_error",
          },
        });
        deps.finishTurn(threadId, active, "failed", detail);

        return;
      }

      case "agent_end":
        if (event.reason === "suspended") {
          if (turn) turn.waiting = true;
          publishSessionState(threadId, active, "waiting");

          return;
        }

        deps.finishTurn(
          threadId,
          active,
          Match.value(event.reason).pipe(
            Match.when("aborted", () => "interrupted" as const),
            Match.when("error", () => "failed" as const),
            Match.orElse(() => "completed" as const),
          ),
        );

        return;
      default:
        return;
    }
  };

  return {
    baseEvent,
    publishSessionState,
    completeAssistantMessage,
    completeAssistantMessages,
    publishAssistantText,
    handleControllerEvent,
  };
}
