// @effect-diagnostics globalDate:off globalConsole:off globalRandom:off nodeBuiltinImport:off globalTimers:off globalFetch:off
/**
 * ClaudeAdapterLive - Scoped live implementation for the Claude Agent provider adapter.
 *
 * Wraps `@anthropic-ai/claude-agent-sdk` query sessions behind the generic
 * provider adapter contract and emits canonical runtime events.
 *
 * @module ClaudeAdapterLive
 */
import { type SDKMessage } from "@anthropic-ai/claude-agent-sdk";

import { EventId, type ProviderRuntimeEvent, RuntimeTaskId } from "@akeru/contracts";

import * as DateTime from "effect/DateTime";

import * as Effect from "effect/Effect";

import { ProviderAdapterRequestError } from "../../Errors.ts";

import { PROVIDER, type ClaudeSessionContext } from "./ClaudeAdapterState.ts";
import {
  asCanonicalTurnId,
  nativeProviderRefs,
  sdkNativeMethod,
  describeUnknownSdkMessage,
} from "./ClaudeProtocolValues.ts";
import {
  trimmedString,
  normalizeTaskUsage,
  CLAUDE_TASK_PATCH_STATUS,
  taskLinkageFor,
  parseWorkflowProgress,
  workflowAgentStatus,
} from "./ClaudeTasks.ts";
import {
  describeClaudeUsageLimit,
  compactBoundaryTokenUsageSnapshot,
  normalizeClaudeTaskProgressTokenUsage,
} from "./ClaudeUsage.ts";

export function createClaudeSystemMessages(deps: {
  readonly makeEventStamp: () => Effect.Effect<
    { eventId: EventId; createdAt: string },
    ProviderAdapterRequestError,
    never
  >;
  readonly offerRuntimeEvent: (event: ProviderRuntimeEvent) => Effect.Effect<void>;
  readonly emitThreadTokenUsage: (
    context: ClaudeSessionContext,
    usage:
      | {
          readonly usedTokens: number;
          readonly totalProcessedTokens?: number | undefined;
          readonly maxTokens?: number | undefined;
          readonly inputTokens?: number | undefined;
          readonly cachedInputTokens?: number | undefined;
          readonly cacheCreationTokens?: number | undefined;
          readonly outputTokens?: number | undefined;
          readonly reasoningOutputTokens?: number | undefined;
          readonly lastUsedTokens?: number | undefined;
          readonly lastInputTokens?: number | undefined;
          readonly lastCachedInputTokens?: number | undefined;
          readonly lastCacheCreationTokens?: number | undefined;
          readonly lastOutputTokens?: number | undefined;
          readonly lastReasoningOutputTokens?: number | undefined;
          readonly toolUses?: number | undefined;
          readonly durationMs?: number | undefined;
          readonly compactsAutomatically?: boolean | undefined;
          readonly autoCompactThreshold?: number | undefined;
        }
      | undefined,
    options?: { readonly rawMethod?: string; readonly rawPayload?: unknown } | undefined,
  ) => Effect.Effect<void, ProviderAdapterRequestError, never>;
  readonly emitRuntimeWarning: (
    context: ClaudeSessionContext,
    message: string,
    detail?: unknown,
    lifecycle?: { readonly key: string; readonly resolved?: boolean } | undefined,
  ) => Effect.Effect<void, ProviderAdapterRequestError, never>;
  readonly emitRuntimeError: (
    context: ClaudeSessionContext,
    message: string,
    cause?: unknown,
  ) => Effect.Effect<void, ProviderAdapterRequestError, never>;
}) {
  const emitWorkflowMemberProgress = Effect.fn("emitWorkflowMemberProgress")(function* (
    context: ClaudeSessionContext,
    base: Omit<ProviderRuntimeEvent, "type" | "payload">,
    message: Extract<SDKMessage, { type: "system"; subtype: "task_progress" }>,
  ) {
    const progress = parseWorkflowProgress(
      (message as unknown as Record<string, unknown>).workflow_progress,
    );

    if (!progress) {
      return;
    }

    const coordinatorId = message.task_id;

    for (const entry of progress.agents) {
      const memberTaskId = `${coordinatorId}:wf:${entry.index}`;
      const status = workflowAgentStatus(entry);

      // Material-transition filter: the wire repeats every member each tick.
      // Emit only when something the client renders actually changed, so a
      // 100-agent fleet costs ~1 event per changed member instead of 100
      // per tick (review finding: unbounded event amplification).
      const fingerprint = [
        status,
        entry.label ?? "",
        entry.model ?? "",
        entry.lastToolName ?? "",
        entry.error ?? "",
        entry.tokens ?? "",
        entry.toolCalls ?? "",
        entry.phaseIndex ?? "",
        entry.phaseTitle ?? "",
        entry.attempt ?? "",
      ].join("\u001f");

      if (context.workflowMemberFingerprints.get(memberTaskId) === fingerprint) {
        continue;
      }

      context.workflowMemberFingerprints.set(memberTaskId, fingerprint);
      const stamp = yield* deps.makeEventStamp();
      yield* deps.offerRuntimeEvent({
        ...base,
        eventId: stamp.eventId,
        createdAt: stamp.createdAt,
        type: "task.progress",
        payload: {
          taskId: RuntimeTaskId.make(memberTaskId),
          description: entry.label ?? `agent ${entry.index}`,
          status,
          ...(entry.error ? { error: entry.error } : {}),
          ...(entry.label ? { title: entry.label } : {}),
          ...(entry.model ? { model: entry.model } : {}),
          ...(entry.lastToolName ? { lastToolName: entry.lastToolName } : {}),
          ...(entry.tokens !== undefined
            ? {
                typedUsage: {
                  totalTokens: entry.tokens,
                  ...(entry.toolCalls !== undefined ? { toolUses: entry.toolCalls } : {}),
                },
              }
            : {}),
          parentAgentId: coordinatorId,
          agentIndex: entry.index,
          ...(entry.phaseIndex !== undefined ? { phaseIndex: entry.phaseIndex } : {}),
          ...(entry.phaseTitle ? { phaseTitle: entry.phaseTitle } : {}),
          ...(entry.attempt !== undefined ? { attempt: entry.attempt } : {}),
          timelineBypass: true,
        },
      });
    }
  });

  const handleSystemMessage = Effect.fn("handleSystemMessage")(function* (
    context: ClaudeSessionContext,
    message: SDKMessage,
  ) {
    if (message.type !== "system") {
      return;
    }

    const stamp = yield* deps.makeEventStamp();

    const base = {
      eventId: stamp.eventId,
      provider: PROVIDER,
      createdAt: stamp.createdAt,
      threadId: context.session.threadId,
      ...(context.turnState ? { turnId: asCanonicalTurnId(context.turnState.turnId) } : {}),
      providerRefs: nativeProviderRefs(context),
      raw: {
        source: "claude.sdk.message" as const,
        method: sdkNativeMethod(message),
        messageType: `${message.type}:${message.subtype}`,
        payload: message,
      },
    };

    // Undeclared-but-real subtypes (absent from the SDK's union, so they can't
    // be switch cases): consumed intentionally without emitting, otherwise
    // they fall through to the unknown-subtype warning and surface as spurious
    // error rows in client work logs. `background_tasks_changed` is a roster
    // snapshot ({tasks: [...]}) — the task_* lifecycle events carry the
    // authoritative per-agent data and the typed background_tasks control
    // request is the reconciliation source. `vcs_state_changed`
    // ({kind: commit|push|rebase}) and `code_change_published`
    // ({provider, url, repo}) are informational CLI notices; the work log
    // already shows the underlying git/gh tool calls.
    switch (message.subtype as string) {
      case "background_tasks_changed":
      case "vcs_state_changed":
      case "code_change_published":
        return;
    }

    switch (message.subtype) {
      case "init":
        yield* deps.offerRuntimeEvent({
          ...base,
          type: "session.configured",
          payload: {
            config: message as Record<string, unknown>,
          },
        });

        return;
      case "status":
        yield* deps.offerRuntimeEvent({
          ...base,
          type: "session.state.changed",
          payload: {
            state: message.status === "compacting" ? "waiting" : "running",
            reason: `status:${message.status ?? "active"}`,
            detail: message,
          },
        });

        return;
      case "compact_boundary":
        if (context.turnState) {
          context.turnState.latestAssistantUsage = undefined;
          context.turnState.compactedSinceLatestAssistantUsage = true;
        }

        yield* deps.emitThreadTokenUsage(
          context,
          compactBoundaryTokenUsageSnapshot(
            message as unknown as Record<string, unknown>,
            context.lastKnownContextWindow,
            context.lastKnownTotalProcessedTokens,
          ),
          {
            rawMethod: "claude/system/compact_boundary",
            rawPayload: message,
          },
        );
        yield* deps.offerRuntimeEvent({
          ...base,
          type: "thread.state.changed",
          payload: {
            state: "compacted",
            detail: message,
          },
        });

        return;
      case "hook_started":
        yield* deps.offerRuntimeEvent({
          ...base,
          type: "hook.started",
          payload: {
            hookId: message.hook_id,
            hookName: message.hook_name,
            hookEvent: message.hook_event,
          },
        });

        return;
      case "hook_progress":
        yield* deps.offerRuntimeEvent({
          ...base,
          type: "hook.progress",
          payload: {
            hookId: message.hook_id,
            output: message.output,
            stdout: message.stdout,
            stderr: message.stderr,
          },
        });

        return;
      case "hook_response":
        yield* deps.offerRuntimeEvent({
          ...base,
          type: "hook.completed",
          payload: {
            hookId: message.hook_id,
            outcome: message.outcome,
            output: message.output,
            stdout: message.stdout,
            stderr: message.stderr,
            ...(typeof message.exit_code === "number" ? { exitCode: message.exit_code } : {}),
          },
        });

        return;
      case "task_started": {
        // A task launched by a tool that itself ran inside a subagent (the
        // in-flight tool carries agentId from parent_tool_use_id) is
        // agent-internal: a subagent's background shell, not parent work.
        const launchingTool = message.tool_use_id
          ? Array.from(context.inFlightTools.values()).find(
              (tool) => tool.itemId === message.tool_use_id,
            )
          : undefined;

        const owningAgentId = launchingTool?.agentId;
        // Model/effort: the Agent tool's input carries explicit overrides;
        // absent ones inherit the session's selection (SDK behavior).
        // Subagent assistant snapshots refine model with the authoritative API
        // id: one that already arrived is buffered and outranks the seed here,
        // later ones refine the record in place. AgentInput.effort may be a
        // named level or an integer.
        const launchInput = launchingTool?.input;
        const toolUseId = message.tool_use_id;
        const bufferedModel = toolUseId ? context.pendingTaskModels.get(toolUseId) : undefined;

        if (toolUseId) {
          context.pendingTaskModels.delete(toolUseId);
        }

        const model =
          bufferedModel ??
          trimmedString(launchInput?.model) ??
          trimmedString(context.session.model ?? undefined);

        const rawLaunchEffort = launchInput?.effort;

        const effort =
          trimmedString(rawLaunchEffort) ??
          (typeof rawLaunchEffort === "number" && Number.isFinite(rawLaunchEffort)
            ? String(rawLaunchEffort)
            : context.currentEffort);

        // Remember the agent identity so every later task.* payload for this
        // taskId is self-describing (identity must survive activity retention).
        context.taskAgents.set(message.task_id, {
          taskId: message.task_id,
          toolUseId: message.tool_use_id,
          description: message.description,
          subagentType: message.subagent_type,
          taskType: message.task_type,
          workflowName: message.workflow_name,
          skipTranscript: message.skip_transcript === true,
          runHandles: context.taskAgents.get(message.task_id)?.runHandles,
          owningAgentId,
          model,
          effort,
        });
        context.liveTaskIds.add(message.task_id);
        yield* deps.offerRuntimeEvent({
          ...base,
          type: "task.started",
          payload: {
            taskId: RuntimeTaskId.make(message.task_id),
            description: message.description,
            ...(message.task_type ? { taskType: message.task_type } : {}),
            ...(owningAgentId ? { agentId: owningAgentId } : {}),
            ...(message.description ? { title: message.description } : {}),
            ...(message.subagent_type ? { role: message.subagent_type } : {}),
            ...(model ? { model } : {}),
            ...(effort ? { effort } : {}),
            ...(message.tool_use_id ? { toolUseId: message.tool_use_id } : {}),
            ...(message.workflow_name ? { workflowName: message.workflow_name } : {}),
          },
        });

        return;
      }

      case "task_progress": {
        yield* deps.emitThreadTokenUsage(
          context,
          normalizeClaudeTaskProgressTokenUsage(message.usage, context),
          {
            rawMethod: "claude/system/task_progress",
            rawPayload: message,
          },
        );
        const linkage = taskLinkageFor(context.taskAgents, message.task_id);
        const typedUsage = normalizeTaskUsage(message.usage);

        // Phases ride on the coordinator's ONE progress row per tick. A
        // separate phases-only row shared the stable ingestion activity id
        // with this full row, and the thinner upsert overwrote usage and
        // progress text (review finding).
        const workflowPhases = parseWorkflowProgress(
          (message as unknown as Record<string, unknown>).workflow_progress,
        )?.phases;

        yield* deps.offerRuntimeEvent({
          ...base,
          type: "task.progress",
          payload: {
            taskId: RuntimeTaskId.make(message.task_id),
            description: message.description,
            ...(message.summary ? { summary: message.summary } : {}),
            ...(message.usage ? { usage: message.usage } : {}),
            ...(typedUsage ? { typedUsage } : {}),
            ...(message.last_tool_name ? { lastToolName: message.last_tool_name } : {}),
            ...(workflowPhases && workflowPhases.length > 0 ? { phases: workflowPhases } : {}),
            ...linkage,
            ...(message.subagent_type ? { role: message.subagent_type } : {}),
          },
        });
        yield* emitWorkflowMemberProgress(context, base, message);

        return;
      }

      case "task_updated": {
        // Status patch (killed/paused/backgrounded/end_time/error) — main
        // previously dropped this on the floor, losing all transitions.
        const patch = message.patch;

        const status =
          patch.status !== undefined ? CLAUDE_TASK_PATCH_STATUS[patch.status] : undefined;

        if (status === "completed" || status === "failed" || status === "cancelled") {
          context.liveTaskIds.delete(message.task_id);
        }

        const endedAt =
          typeof patch.end_time === "number" && Number.isFinite(patch.end_time)
            ? DateTime.formatIso(DateTime.makeUnsafe(patch.end_time))
            : undefined;

        yield* deps.offerRuntimeEvent({
          ...base,
          type: "task.updated",
          payload: {
            taskId: RuntimeTaskId.make(message.task_id),
            ...(status ? { status } : {}),
            ...(patch.description ? { description: patch.description } : {}),
            ...(patch.error ? { error: patch.error } : {}),
            ...(endedAt ? { endedAt } : {}),
            ...(patch.is_backgrounded !== undefined
              ? { isBackgrounded: patch.is_backgrounded }
              : {}),
            ...taskLinkageFor(context.taskAgents, message.task_id),
          },
        });

        return;
      }

      case "task_notification": {
        context.liveTaskIds.delete(message.task_id);
        yield* deps.emitThreadTokenUsage(
          context,
          normalizeClaudeTaskProgressTokenUsage(message.usage, context),
          {
            rawMethod: "claude/system/task_notification",
            rawPayload: message,
          },
        );
        const typedUsage = normalizeTaskUsage(message.usage);
        yield* deps.offerRuntimeEvent({
          ...base,
          type: "task.completed",
          payload: {
            taskId: RuntimeTaskId.make(message.task_id),
            status: message.status,
            ...(message.summary ? { summary: message.summary } : {}),
            ...(message.usage ? { usage: message.usage } : {}),
            ...(typedUsage ? { typedUsage } : {}),
            ...(message.output_file ? { outputFile: message.output_file } : {}),
            ...taskLinkageFor(context.taskAgents, message.task_id),
          },
        });

        return;
      }

      case "files_persisted":
        yield* deps.offerRuntimeEvent({
          ...base,
          type: "files.persisted",
          payload: {
            files: Array.isArray(message.files)
              ? message.files.map((file: { filename: string; file_id: string }) => ({
                  filename: file.filename,
                  fileId: file.file_id,
                }))
              : [],
            ...(Array.isArray(message.failed)
              ? {
                  failed: message.failed.map((entry: { filename: string; error: string }) => ({
                    filename: entry.filename,
                    error: entry.error,
                  })),
                }
              : {}),
          },
        });

        return;
      case "thinking_tokens":
        return;
      case "api_retry":
        // Transport-level retry heartbeat. Surfacing each attempt as a
        // warning row spammed the work log (10 rows during a 502 storm);
        // the terminal result/error path reports the actual failure. Keep
        // the session visibly alive instead.
        yield* deps.offerRuntimeEvent({
          ...base,
          type: "session.state.changed",
          payload: {
            state: "running",
            reason: `api_retry:${message.attempt}/${message.max_retries}`,
          },
        });

        return;
      case "session_state_changed":
        // Authoritative turn-over signal from the CLI.
        yield* deps.offerRuntimeEvent({
          ...base,
          type: "session.state.changed",
          payload: {
            state:
              message.state === "running"
                ? "running"
                : message.state === "requires_action"
                  ? "waiting"
                  : "ready",
            reason: `session_state:${message.state}`,
          },
        });

        return;
      case "notification":
        // User-facing CLI notification (e.g. context-limit warnings). Only
        // high-priority ones warrant a work-log row.
        if (message.priority === "high" || message.priority === "immediate") {
          yield* deps.emitRuntimeWarning(context, message.text, message);
        }

        return;
      // Inner protocol/UX details with no T3 surface today — consumed
      // deliberately so they don't masquerade as unknown-subtype warnings.
      case "model_refusal_fallback":
      case "local_command_output":
      case "plugin_install":
      case "commands_changed":
      case "memory_recall":
      case "elicitation_complete":
        return;
      case "permission_denied":
        yield* deps.offerRuntimeEvent({
          ...base,
          type: "tool.denied",
          payload: {
            toolName: message.tool_name,
            ...(message.tool_use_id ? { toolUseId: message.tool_use_id } : {}),
            ...(message.decision_reason ? { reason: message.decision_reason } : {}),
            ...(message.agent_id ? { agentId: message.agent_id } : {}),
          },
        });

        return;
      case "mirror_error":
        yield* deps.emitRuntimeError(
          context,
          `Claude workspace mirror error: ${message.error}`,
          message,
        );

        return;
      default: {
        // Exhaustiveness guard: every subtype in the SDK's typed union is
        // handled above, so `message` narrows to never here — a new SDK
        // release adding a subtype fails this typecheck instead of silently
        // warning at runtime. The runtime fallback still catches undeclared
        // wire-only subtypes (like background_tasks_changed used to be).
        message satisfies never;
        const unknownMessage = message as never as { subtype: string };
        yield* deps.emitRuntimeWarning(
          context,
          describeUnknownSdkMessage(`Claude system message '${unknownMessage.subtype}'`, message),
          message,
        );

        return;
      }
    }
  });

  const handleSdkTelemetryMessage = Effect.fn("handleSdkTelemetryMessage")(function* (
    context: ClaudeSessionContext,
    message: SDKMessage,
  ) {
    const stamp = yield* deps.makeEventStamp();

    const base = {
      eventId: stamp.eventId,
      provider: PROVIDER,
      createdAt: stamp.createdAt,
      threadId: context.session.threadId,
      ...(context.turnState ? { turnId: asCanonicalTurnId(context.turnState.turnId) } : {}),
      providerRefs: nativeProviderRefs(context),
      raw: {
        source: "claude.sdk.message" as const,
        method: sdkNativeMethod(message),
        messageType: message.type,
        payload: message,
      },
    };

    if (message.type === "tool_progress") {
      yield* deps.offerRuntimeEvent({
        ...base,
        type: "tool.progress",
        payload: {
          toolUseId: message.tool_use_id,
          toolName: message.tool_name,
          elapsedSeconds: message.elapsed_time_seconds,
          ...(message.task_id ? { taskId: RuntimeTaskId.make(message.task_id) } : {}),
          ...(message.parent_tool_use_id !== null
            ? { parentToolUseId: message.parent_tool_use_id }
            : {}),
        },
      });

      return;
    }

    if (message.type === "tool_use_summary") {
      yield* deps.offerRuntimeEvent({
        ...base,
        type: "tool.summary",
        payload: {
          summary: message.summary,
          ...(message.preceding_tool_use_ids.length > 0
            ? {
                precedingToolUseIds: message.preceding_tool_use_ids,
              }
            : {}),
        },
      });

      return;
    }

    if (message.type === "auth_status") {
      yield* deps.offerRuntimeEvent({
        ...base,
        type: "auth.status",
        payload: {
          isAuthenticating: message.isAuthenticating,
          output: message.output,
          ...(message.error ? { error: message.error } : {}),
        },
      });

      return;
    }

    if (message.type === "rate_limit_event") {
      yield* deps.offerRuntimeEvent({
        ...base,
        type: "account.rate-limits.updated",
        payload: {
          rateLimits: message,
        },
      });
      const rateLimitInfo = message.rate_limit_info;

      if (!rateLimitInfo) return;

      // A rejected window parks the turn inside the SDK: no further messages
      // arrive and no result lands, so without a row the thread just spins.
      // Warnings (allowed_warning) still have headroom and stay quiet, an
      // account spending provisioned overage keeps running despite the reject,
      // and between turns there is no turn to report as paused.
      const overageAllowed =
        rateLimitInfo.overageStatus === "allowed" ||
        rateLimitInfo.overageStatus === "allowed_warning" ||
        rateLimitInfo.isUsingOverage === true ||
        rateLimitInfo.overageInUse === true;

      const blocked = rateLimitInfo.status === "rejected" && !overageAllowed;
      const limitType = rateLimitInfo.rateLimitType ?? "unknown";
      const limitKey = `${limitType}:${rateLimitInfo.resetsAt ?? "unknown"}`;
      const warningKey = `claude.rate-limit:${limitType}`;

      const recovered =
        context.turnState?.rejectedRateLimitTypes.has(limitType) === true && !blocked;

      if (context.turnState) {
        // Current blocking evidence is independent of whether its warning has
        // already been shown. A recovery can omit or advance the reset time;
        // its window type remains stable without clearing another window.
        if (blocked) context.turnState.rejectedRateLimitTypes.add(limitType);
        else if (
          rateLimitInfo.status === "allowed" ||
          rateLimitInfo.status === "allowed_warning" ||
          overageAllowed
        ) {
          context.turnState.rejectedRateLimitTypes.delete(limitType);
        }
      }

      if (blocked && context.turnState !== undefined) {
        const turnId = context.turnState.turnId;

        if (context.announcedUsageLimits?.turnId !== turnId) {
          context.announcedUsageLimits = { turnId, keys: new Set() };
        }

        if (!context.announcedUsageLimits.keys.has(limitKey)) {
          context.announcedUsageLimits.keys.add(limitKey);
          const notice = describeClaudeUsageLimit(rateLimitInfo, Date.parse(stamp.createdAt));
          yield* deps.emitRuntimeWarning(context, notice, rateLimitInfo, { key: warningKey });
        }
      } else if (recovered) {
        yield* deps.emitRuntimeWarning(
          context,
          "Claude usage limit recovered. Processing resumed.",
          rateLimitInfo,
          { key: warningKey, resolved: true },
        );
      }

      return;
    }
  });

  return { emitWorkflowMemberProgress, handleSystemMessage, handleSdkTelemetryMessage };
}
