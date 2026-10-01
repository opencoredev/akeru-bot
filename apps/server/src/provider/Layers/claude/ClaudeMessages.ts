// @effect-diagnostics globalDate:off globalConsole:off globalRandom:off nodeBuiltinImport:off globalTimers:off globalFetch:off
/**
 * ClaudeAdapterLive - Scoped live implementation for the Claude Agent provider adapter.
 *
 * Wraps `@anthropic-ai/claude-agent-sdk` query sessions behind the generic
 * provider adapter contract and emits canonical runtime events.
 *
 * @module ClaudeAdapterLive
 */
import { type SDKMessage, type SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";

import { EventId, type ProviderRuntimeEvent, type TaskRunHandles, TurnId } from "@akeru/contracts";

import * as Effect from "effect/Effect";

import * as Path from "effect/Path";

import { claudeSignedOutMessage } from "../../Drivers/ClaudeHome.ts";

import { ProviderAdapterRequestError } from "../../Errors.ts";

import {
  PROVIDER,
  createClaudeTurnState,
  type ClaudeSessionContext,
} from "./ClaudeAdapterState.ts";
import {
  asRuntimeItemId,
  asCanonicalTurnId,
  nativeProviderRefs,
  extractExitPlanModePlan,
  toolResultStreamKind,
  toolResultBlocksFromUserMessage,
} from "./ClaudeProtocolValues.ts";
import {
  rememberPendingTaskModel,
  readClaudeToolUseResult,
  applyClaudeTaskToolResult,
  sanitizeSessionUrl,
  trimmedString,
  agentIdForParentToolUse,
} from "./ClaudeTasks.ts";
import { normalizeClaudeActiveTokenUsage, resultOutcome } from "./ClaudeUsage.ts";

export function createClaudeMessages(deps: {
  readonly makeEventStamp: () => Effect.Effect<
    { eventId: EventId; createdAt: string },
    ProviderAdapterRequestError,
    never
  >;
  readonly offerRuntimeEvent: (event: ProviderRuntimeEvent) => Effect.Effect<void>;
  readonly emitClaudeTaskPlanUpdated: (
    context: ClaudeSessionContext,
    input: { readonly toolUseId: string; readonly rawMethod: string; readonly rawPayload: unknown },
  ) => Effect.Effect<void, ProviderAdapterRequestError, never>;
  readonly updateResumeCursor: (context: ClaudeSessionContext) => Effect.Effect<void, never, never>;
  readonly randomUUIDv4: Effect.Effect<string, ProviderAdapterRequestError, never>;
  readonly nowIso: Effect.Effect<string, never, never>;
  readonly emitProposedPlanCompleted: (
    context: ClaudeSessionContext,
    input: {
      readonly planMarkdown: string;
      readonly toolUseId?: string | undefined;
      readonly rawSource: "claude.sdk.message" | "claude.sdk.permission";
      readonly rawMethod: string;
      readonly rawPayload: unknown;
    },
  ) => Effect.Effect<void, ProviderAdapterRequestError, never>;
  readonly claudeEnvironment: NodeJS.ProcessEnv;
  readonly path: Path.Path;
  readonly backfillAssistantTextBlocksFromSnapshot: (
    context: ClaudeSessionContext,
    message: SDKMessage,
  ) => Effect.Effect<void, ProviderAdapterRequestError, never>;
  readonly emitRuntimeError: (
    context: ClaudeSessionContext,
    message: string,
    cause?: unknown,
  ) => Effect.Effect<void, ProviderAdapterRequestError, never>;
  readonly completeTurn: (
    context: ClaudeSessionContext,
    status: "completed" | "failed" | "interrupted" | "cancelled",
    errorMessage?: string | undefined,
    result?: SDKResultMessage | undefined,
  ) => Effect.Effect<void, ProviderAdapterRequestError, never>;
}) {
  const handleUserMessage = Effect.fn("handleUserMessage")(function* (
    context: ClaudeSessionContext,
    message: SDKMessage,
  ) {
    if (message.type !== "user") {
      return;
    }

    if (context.turnState) {
      context.turnState.items.push(message.message);
    }

    for (const toolResult of toolResultBlocksFromUserMessage(message)) {
      const toolEntry = Array.from(context.inFlightTools.entries()).find(
        ([, tool]) => tool.itemId === toolResult.toolUseId,
      );

      if (!toolEntry) {
        continue;
      }

      const [index, tool] = toolEntry;
      const itemStatus = toolResult.isError ? "failed" : "completed";
      const toolUseResult = readClaudeToolUseResult(message);

      const toolData = {
        toolName: tool.toolName,
        input: tool.input,
        result: toolResult.block,
      };

      const updatedStamp = yield* deps.makeEventStamp();
      yield* deps.offerRuntimeEvent({
        type: "item.updated",
        eventId: updatedStamp.eventId,
        provider: PROVIDER,
        createdAt: updatedStamp.createdAt,
        threadId: context.session.threadId,
        ...(context.turnState ? { turnId: asCanonicalTurnId(context.turnState.turnId) } : {}),
        itemId: asRuntimeItemId(tool.itemId),
        payload: {
          itemType: tool.itemType,
          status: toolResult.isError ? "failed" : "inProgress",
          title: tool.title,
          ...(tool.detail ? { detail: tool.detail } : {}),
          ...(tool.agentId ? { agentId: tool.agentId } : {}),
          ...(tool.parentToolUseId ? { parentToolUseId: tool.parentToolUseId } : {}),
          data: toolData,
        },
        providerRefs: nativeProviderRefs(context, {
          providerItemId: tool.itemId,
        }),
        raw: {
          source: "claude.sdk.message",
          method: "claude/user",
          payload: message,
        },
      });

      const streamKind = toolResultStreamKind(tool.itemType);

      if (streamKind && toolResult.text.length > 0 && context.turnState) {
        const deltaStamp = yield* deps.makeEventStamp();
        yield* deps.offerRuntimeEvent({
          type: "content.delta",
          eventId: deltaStamp.eventId,
          provider: PROVIDER,
          createdAt: deltaStamp.createdAt,
          threadId: context.session.threadId,
          turnId: context.turnState.turnId,
          itemId: asRuntimeItemId(tool.itemId),
          payload: {
            streamKind,
            delta: toolResult.text,
          },
          providerRefs: nativeProviderRefs(context, {
            providerItemId: tool.itemId,
          }),
          raw: {
            source: "claude.sdk.message",
            method: "claude/user",
            payload: message,
          },
        });
      }

      const completedStamp = yield* deps.makeEventStamp();
      yield* deps.offerRuntimeEvent({
        type: "item.completed",
        eventId: completedStamp.eventId,
        provider: PROVIDER,
        createdAt: completedStamp.createdAt,
        threadId: context.session.threadId,
        ...(context.turnState ? { turnId: asCanonicalTurnId(context.turnState.turnId) } : {}),
        itemId: asRuntimeItemId(tool.itemId),
        payload: {
          itemType: tool.itemType,
          status: itemStatus,
          title: tool.title,
          ...(tool.detail ? { detail: tool.detail } : {}),
          ...(tool.agentId ? { agentId: tool.agentId } : {}),
          ...(tool.parentToolUseId ? { parentToolUseId: tool.parentToolUseId } : {}),
          data: toolData,
        },
        providerRefs: nativeProviderRefs(context, {
          providerItemId: tool.itemId,
        }),
        raw: {
          source: "claude.sdk.message",
          method: "claude/user",
          payload: message,
        },
      });

      // The Workflow tool's result carries the run handles (runId, scriptPath,
      // transcriptDir, sessionUrl). Attach them to the workflow's task agent so
      // the next task.* payload advertises them to clients.
      if (!toolResult.isError && tool.toolName.toLowerCase() === "workflow" && toolUseResult) {
        const workflowTaskId = trimmedString(toolUseResult.taskId);

        if (workflowTaskId) {
          const runHandles: TaskRunHandles = {
            ...(trimmedString(toolUseResult.runId)
              ? { runId: trimmedString(toolUseResult.runId) }
              : {}),
            ...(trimmedString(toolUseResult.scriptPath)
              ? { scriptPath: trimmedString(toolUseResult.scriptPath) }
              : {}),
            ...(trimmedString(toolUseResult.transcriptDir)
              ? { transcriptDir: trimmedString(toolUseResult.transcriptDir) }
              : {}),
            ...(sanitizeSessionUrl(toolUseResult.sessionUrl)
              ? { sessionUrl: sanitizeSessionUrl(toolUseResult.sessionUrl) }
              : {}),
          };

          const existing = context.taskAgents.get(workflowTaskId);
          context.taskAgents.set(workflowTaskId, {
            taskId: workflowTaskId,
            toolUseId: existing?.toolUseId ?? tool.itemId,
            description: existing?.description,
            subagentType: existing?.subagentType,
            taskType: existing?.taskType ?? "local_workflow",
            workflowName: existing?.workflowName,
            skipTranscript: existing?.skipTranscript ?? false,
            runHandles,
            owningAgentId: existing?.owningAgentId,
            model: existing?.model,
            effort: existing?.effort,
          });
        }
      }

      if (
        !toolResult.isError &&
        applyClaudeTaskToolResult(context.claudeTasks, tool, toolUseResult)
      ) {
        yield* deps.emitClaudeTaskPlanUpdated(context, {
          toolUseId: tool.itemId,
          rawMethod: "claude/user",
          rawPayload: message,
        });
      }

      context.inFlightTools.delete(index);
    }
  });

  const handleAssistantMessage = Effect.fn("handleAssistantMessage")(function* (
    context: ClaudeSessionContext,
    message: SDKMessage,
  ) {
    if (message.type !== "assistant") {
      return;
    }

    // Subagent-owned assistant snapshots (parent_tool_use_id set) are the
    // subagent's own conversation, not the parent's. Emitting them created
    // interleaved "Agent N done"-adjacent leak messages and spawned synthetic
    // turns per subagent completion (which also reset the Working timer).
    const assistantParentToolUseId = (message as { parent_tool_use_id?: string | null })
      .parent_tool_use_id;

    if (assistantParentToolUseId !== null && assistantParentToolUseId !== undefined) {
      // The snapshot's message.model is the authoritative API model the
      // subagent actually ran on — refine the seeded launch-time value.
      const owningTaskId = agentIdForParentToolUse(context.taskAgents, assistantParentToolUseId);
      const snapshotModel = trimmedString(message.message.model);
      const owningAgent = owningTaskId ? context.taskAgents.get(owningTaskId) : undefined;

      if (snapshotModel) {
        if (owningAgent) {
          owningAgent.model = snapshotModel;
        } else {
          // The snapshot beat its task_started (or its tool_use_id was never
          // recorded): hold the model until the task registers.
          rememberPendingTaskModel(
            context.pendingTaskModels,
            assistantParentToolUseId,
            snapshotModel,
          );
        }
      }

      context.lastAssistantUuid = message.uuid;
      yield* deps.updateResumeCursor(context);

      return;
    }

    // Auto-start a synthetic turn for assistant messages that arrive without
    // an active turn (e.g., background agent/subagent responses between user prompts).
    if (!context.turnState) {
      const turnId = TurnId.make(yield* deps.randomUUIDv4);
      const startedAt = yield* deps.nowIso;
      context.turnState = createClaudeTurnState(turnId, startedAt, { synthetic: true });
      context.session = {
        ...context.session,
        status: "running",
        activeTurnId: turnId,
        updatedAt: startedAt,
      };
      const turnStartedStamp = yield* deps.makeEventStamp();
      yield* deps.offerRuntimeEvent({
        type: "turn.started",
        eventId: turnStartedStamp.eventId,
        provider: PROVIDER,
        createdAt: turnStartedStamp.createdAt,
        threadId: context.session.threadId,
        turnId,
        payload: {},
        providerRefs: {
          ...nativeProviderRefs(context),
          providerTurnId: turnId,
        },
        raw: {
          source: "claude.sdk.message",
          method: "claude/synthetic-turn-start",
          payload: {},
        },
      });
    }

    const content = message.message?.content;

    if (Array.isArray(content)) {
      for (const block of content) {
        if (!block || typeof block !== "object") {
          continue;
        }

        const toolUse = block as {
          type?: unknown;
          id?: unknown;
          name?: unknown;
          input?: unknown;
        };

        if (toolUse.type !== "tool_use" || toolUse.name !== "ExitPlanMode") {
          continue;
        }

        const planMarkdown = extractExitPlanModePlan(toolUse.input);

        if (!planMarkdown) {
          continue;
        }

        yield* deps.emitProposedPlanCompleted(context, {
          planMarkdown,
          toolUseId: typeof toolUse.id === "string" ? toolUse.id : undefined,
          rawSource: "claude.sdk.message",
          rawMethod: "claude/assistant",
          rawPayload: message,
        });
      }
    }

    if (context.turnState) {
      // Limited retries may only carry an assistant error, without a new window
      // event. Later parent responses replace this evidence if the turn recovers.
      context.turnState.latestAssistantRateLimited = message.error === "rate_limit";

      // The CLI can report authentication failure before ending the turn as a
      // generic API error, so retain that evidence for the result fallback.
      if (message.error === "authentication_failed") {
        context.turnState.authenticationFailureMessage = claudeSignedOutMessage({
          configDir: deps.claudeEnvironment.CLAUDE_CONFIG_DIR,
          cwd: deps.path.resolve(context.session.cwd ?? "."),
        });
      }

      context.turnState.items.push(message.message);

      if (
        normalizeClaudeActiveTokenUsage(
          message.message.usage,
          context.lastKnownContextWindow,
          context.lastKnownTotalProcessedTokens,
        )
      ) {
        context.turnState.latestAssistantUsage = message.message.usage;
        context.turnState.compactedSinceLatestAssistantUsage = false;
      }

      yield* deps.backfillAssistantTextBlocksFromSnapshot(context, message);
    }

    context.lastAssistantUuid = message.uuid;
    yield* deps.updateResumeCursor(context);
  });

  const handleResultMessage = Effect.fn("handleResultMessage")(function* (
    context: ClaudeSessionContext,
    message: SDKMessage,
  ) {
    if (message.type !== "result") {
      return;
    }

    const turn = context.turnState;

    const failureHint =
      turn?.authenticationFailureMessage ??
      (turn && (turn.rejectedRateLimitTypes.size > 0 || turn.latestAssistantRateLimited)
        ? "Claude usage limit reached. Send the message again once the limit resets."
        : undefined);

    const { status, errorMessage } = resultOutcome(message, failureHint);

    if (status === "failed") {
      yield* deps.emitRuntimeError(context, errorMessage ?? "Claude turn failed.");
    }

    yield* deps.completeTurn(context, status, errorMessage, message);
  });

  return { handleUserMessage, handleAssistantMessage, handleResultMessage };
}
