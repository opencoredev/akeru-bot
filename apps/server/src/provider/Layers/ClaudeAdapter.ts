import { readSdkRecord } from "./ProtocolJson.ts";
import * as Predicate from "effect/Predicate";
import { createClaudeTextStreams } from "./claude/ClaudeTextStreams.ts";
import { createClaudeMessages } from "./claude/ClaudeMessages.ts";
import { createClaudeSystemMessages } from "./claude/ClaudeSystemMessages.ts";
import { createClaudeTurnCompletion } from "./claude/ClaudeTurnCompletion.ts";
import { createClaudeSessionLifecycle } from "./claude/ClaudeSessionLifecycle.ts";
import { createClaudeStreamLifecycle } from "./claude/ClaudeStreamLifecycle.ts";
/**
 * ClaudeAdapterLive - Scoped live implementation for the Claude Agent provider adapter.
 *
 * Wraps `@anthropic-ai/claude-agent-sdk` query sessions behind the generic
 * provider adapter contract and emits canonical runtime events.
 *
 * @module ClaudeAdapterLive
 */
import {
  query,
  type Options as ClaudeQueryOptions,
  type SDKMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";

import {
  type ClaudeSettings,
  EventId,
  ProviderInstanceId,
  ProviderItemId,
  type ProviderRuntimeEvent,
  ThreadId,
  TurnId,
} from "@akeru/contracts";
import { getModelSelectionStringOptionValue } from "@akeru/shared/model";

import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";

import * as FileSystem from "effect/FileSystem";

import * as Path from "effect/Path";
import * as Queue from "effect/Queue";

import * as Stream from "effect/Stream";
import { ServerConfig } from "../../config.ts";

import { resolveClaudeSdkExecutablePath } from "../Drivers/ClaudeExecutable.ts";
// oxlint-disable-next-line anti-slop-effect/no-service-constructor-imports -- Provider composition root constructs an environment from this instance configuration.
import { makeClaudeEnvironment } from "../Drivers/ClaudeHome.ts";
import { discoverClaudeSkills } from "../Drivers/ClaudeSkills.ts";
import {
  getClaudeModelCapabilities,
  resolveClaudeApiModelId,
  resolveClaudeEffort,
} from "./claude/ClaudeModels.ts";
import {
  ProviderAdapterRequestError,
  ProviderAdapterSessionClosedError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
  type ProviderAdapterError,
} from "../Errors.ts";
import { type ClaudeAdapterShape } from "../Services/ClaudeAdapter.ts";
import { type EventNdjsonLogger } from "./logging/EventLogTypes.ts";
// oxlint-disable-next-line anti-slop-effect/no-service-constructor-imports -- Adapter composition root creates the scoped logger with this adapter configuration.
import { makeEventNdjsonLogger } from "./EventNdjsonLogger.ts";

import {
  PROVIDER,
  type ClaudeTurnState,
  createClaudeTurnState,
  type ClaudeSessionContext,
  type ClaudeQueryRuntime,
} from "./claude/ClaudeAdapterState.ts";
import {
  hasDurableClaudeSessionId,
  getEffectiveClaudeAgentEffort,
  asCanonicalTurnId,
  nativeProviderRefs,
  toRequestError,
  sdkMessageType,
  sdkNativeMethod,
  describeUnknownSdkMessage,
  sdkNativeItemId,
} from "./claude/ClaudeProtocolValues.ts";

import { buildUserMessageEffect } from "./claude/ClaudePrompt.ts";

export interface ClaudeAdapterLiveOptions {
  readonly instanceId?: ProviderInstanceId;
  readonly environment?: NodeJS.ProcessEnv;
  readonly createQuery?: (input: {
    readonly prompt: AsyncIterable<SDKUserMessage>;
    readonly options: ClaudeQueryOptions;
  }) => ClaudeQueryRuntime;
  readonly nativeEventLogPath?: string;
  readonly nativeEventLogger?: EventNdjsonLogger;
}

export const makeClaudeAdapter = Effect.fn("makeClaudeAdapter")(function* (
  claudeSettings: ClaudeSettings,
  options?: ClaudeAdapterLiveOptions,
) {
  const boundInstanceId = options?.instanceId ?? ProviderInstanceId.make("claudeAgent");
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const serverConfig = yield* ServerConfig;
  const crypto = yield* Crypto.Crypto;

  const claudeEnvironment = yield* makeClaudeEnvironment(claudeSettings, options?.environment).pipe(
    Effect.provideService(Path.Path, path),
  );

  const claudeSdkExecutablePath = yield* resolveClaudeSdkExecutablePath(
    claudeSettings.binaryPath,
    claudeEnvironment,
  );

  const nativeEventLogger =
    options?.nativeEventLogger ??
    (options?.nativeEventLogPath !== undefined
      ? yield* makeEventNdjsonLogger(options.nativeEventLogPath, {
          stream: "native",
        })
      : undefined);

  const managedNativeEventLogger =
    options?.nativeEventLogger === undefined ? nativeEventLogger : undefined;

  const createQuery =
    options?.createQuery ??
    ((input: {
      readonly prompt: AsyncIterable<SDKUserMessage>;
      readonly options: ClaudeQueryOptions;
    }) =>
      query({
        prompt: input.prompt,
        options: input.options,
      }));

  const sessions = new Map<ThreadId, ClaudeSessionContext>();
  const runtimeEventQueue = yield* Queue.unbounded<ProviderRuntimeEvent>();

  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

  const randomUUIDv4 = crypto.randomUUIDv4.pipe(
    Effect.mapError(
      (cause) =>
        new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "crypto/randomUUIDv4",
          detail: "Failed to generate Claude runtime identifier.",
          cause,
        }),
    ),
  );

  const nextEventId = Effect.map(randomUUIDv4, (id) => EventId.make(id));
  const makeEventStamp = () => Effect.all({ eventId: nextEventId, createdAt: nowIso });

  const offerRuntimeEvent = (event: ProviderRuntimeEvent): Effect.Effect<void> =>
    Queue.offer(runtimeEventQueue, event).pipe(Effect.asVoid);

  const logNativeSdkMessage = Effect.fnUntraced(function* (
    context: ClaudeSessionContext,
    message: SDKMessage,
  ) {
    if (!nativeEventLogger) {
      return;
    }

    const observedAt = yield* nowIso;
    const itemId = sdkNativeItemId(message);

    yield* nativeEventLogger.write(
      {
        observedAt,
        event: {
          id:
            "uuid" in message && Predicate.isString(message.uuid)
              ? message.uuid
              : yield* randomUUIDv4,
          kind: "notification",
          provider: PROVIDER,
          createdAt: observedAt,
          method: sdkNativeMethod(message),
          ...(Predicate.isString(message.session_id)
            ? { providerThreadId: message.session_id }
            : {}),
          ...(context.turnState
            ? {
                turnId: asCanonicalTurnId(context.turnState.turnId),
              }
            : {}),
          ...(itemId ? { itemId: ProviderItemId.make(itemId) } : {}),
          payload: message,
        },
      },
      context.session.threadId,
    );
  });

  const snapshotThread = Effect.fn("snapshotThread")(function* (context: ClaudeSessionContext) {
    const threadId = context.session.threadId;

    if (!threadId) {
      return yield* new ProviderAdapterValidationError({
        provider: PROVIDER,
        operation: "readThread",
        issue: "Session thread id is not initialized yet.",
      });
    }

    return {
      threadId,
      turns: context.turns.map((turn) => ({
        id: turn.id,
        items: [...turn.items],
      })),
    };
  });

  const updateResumeCursor = Effect.fn("updateResumeCursor")(function* (
    context: ClaudeSessionContext,
  ) {
    const threadId = context.session.threadId;

    if (!threadId) return;

    const resumeCursor = {
      threadId,
      ...(context.resumeSessionId ? { resume: context.resumeSessionId } : {}),
      ...(context.lastAssistantUuid ? { resumeSessionAt: context.lastAssistantUuid } : {}),
      turnCount: context.turns.length,
    };

    context.session = {
      ...context.session,
      resumeCursor,
      updatedAt: yield* nowIso,
    };
  });

  const { completeAssistantTextBlock, backfillAssistantTextBlocksFromSnapshot, handleStreamEvent } =
    createClaudeTextStreams({
      randomUUIDv4,
      makeEventStamp,
      offerRuntimeEvent,
      get emitThreadTokenUsage() {
        return emitThreadTokenUsage;
      },
    });

  const ensureThreadId = Effect.fn("ensureThreadId")(function* (
    context: ClaudeSessionContext,
    message: SDKMessage,
  ) {
    if (!Predicate.isString(message.session_id) || message.session_id.length === 0) {
      return;
    }

    if (!hasDurableClaudeSessionId(message)) {
      return;
    }

    const nextThreadId = message.session_id;
    context.resumeSessionId = message.session_id;
    yield* updateResumeCursor(context);

    if (context.lastThreadStartedId !== nextThreadId) {
      context.lastThreadStartedId = nextThreadId;
      const stamp = yield* makeEventStamp();
      yield* offerRuntimeEvent({
        type: "thread.started",
        eventId: stamp.eventId,
        provider: PROVIDER,
        createdAt: stamp.createdAt,
        threadId: context.session.threadId,
        payload: {
          providerThreadId: nextThreadId,
        },
        providerRefs: {},
        raw: {
          source: "claude.sdk.message",
          method: "claude/thread/started",
          payload: {
            session_id: message.session_id,
          },
        },
      });
    }
  });

  const emitRuntimeError = Effect.fn("emitRuntimeError")(function* (
    context: ClaudeSessionContext,
    message: string,
    cause?: unknown,
  ) {
    if (cause !== undefined) {
      void cause;
    }

    const turnState = context.turnState;
    const stamp = yield* makeEventStamp();
    yield* offerRuntimeEvent({
      type: "runtime.error",
      eventId: stamp.eventId,
      provider: PROVIDER,
      createdAt: stamp.createdAt,
      threadId: context.session.threadId,
      ...(turnState ? { turnId: asCanonicalTurnId(turnState.turnId) } : {}),
      payload: {
        message,
        class: "provider_error",
        ...(cause !== undefined ? { detail: cause } : {}),
      },
      providerRefs: nativeProviderRefs(context),
    });
  });

  const emitRuntimeWarning = Effect.fn("emitRuntimeWarning")(function* (
    context: ClaudeSessionContext,
    message: string,
    detail?: Extract<ProviderRuntimeEvent, { type: "runtime.warning" }>["payload"]["detail"],
    lifecycle?: { readonly key: string; readonly resolved?: boolean },
  ) {
    const turnState = context.turnState;
    const stamp = yield* makeEventStamp();
    yield* offerRuntimeEvent({
      type: "runtime.warning",
      eventId: stamp.eventId,
      provider: PROVIDER,
      createdAt: stamp.createdAt,
      threadId: context.session.threadId,
      ...(turnState ? { turnId: asCanonicalTurnId(turnState.turnId) } : {}),
      payload: {
        message,
        ...(detail !== undefined ? { detail } : {}),
        ...(lifecycle ? { key: lifecycle.key } : {}),
        ...(lifecycle?.resolved === true ? { resolved: true } : {}),
      },
      providerRefs: nativeProviderRefs(context),
    });
  });

  const {
    emitThreadTokenUsage,
    emitProposedPlanCompleted,
    emitClaudeTaskPlanUpdated,
    completeTurn,
  } = createClaudeTurnCompletion({
    makeEventStamp,
    offerRuntimeEvent,
    completeAssistantTextBlock,
    nowIso,
    updateResumeCursor,
  });

  const { handleUserMessage, handleAssistantMessage, handleResultMessage } = createClaudeMessages({
    makeEventStamp,
    offerRuntimeEvent,
    emitClaudeTaskPlanUpdated,
    updateResumeCursor,
    randomUUIDv4,
    nowIso,
    emitProposedPlanCompleted,
    claudeEnvironment,
    path,
    backfillAssistantTextBlocksFromSnapshot,
    emitRuntimeError,
    completeTurn,
  });

  /**
   * Synthesizes per-member task.progress rows from the coordinator's
   * workflow_progress array. Member identity is the stable slot
   * `<coordinatorTaskId>:wf:<index>` (never the per-attempt agent id, which
   * changes on retry and would split one member into duplicate rows).
   * timelineBypass keeps these out of the parent chat; the Agents surface and
   * workflow card consume them.
   */
  const { handleSystemMessage, handleSdkTelemetryMessage } = createClaudeSystemMessages({
    makeEventStamp,
    offerRuntimeEvent,
    emitThreadTokenUsage,
    emitRuntimeWarning,
    emitRuntimeError,
  });

  const handleSdkMessage = Effect.fn("handleSdkMessage")(function* (
    context: ClaudeSessionContext,
    message: SDKMessage,
  ) {
    yield* logNativeSdkMessage(context, message);
    yield* ensureThreadId(context, message);

    // Wire-only command bookkeeping has no user-facing T3 lifecycle.
    if (sdkMessageType(message) === "command_lifecycle") {
      return;
    }

    switch (message.type) {
      case "stream_event":
        yield* handleStreamEvent(context, message);

        return;
      case "user":
        yield* handleUserMessage(context, message);

        return;
      case "assistant":
        yield* handleAssistantMessage(context, message);

        return;
      case "result":
        yield* handleResultMessage(context, message);

        return;
      case "system":
        yield* handleSystemMessage(context, message);

        return;
      case "tool_progress":
      case "tool_use_summary":
      case "auth_status":
      case "rate_limit_event":
        yield* handleSdkTelemetryMessage(context, message);

        return;
      // Composer prompt suggestions have no T3 surface; consumed deliberately.
      case "prompt_suggestion":
        return;
      default: {
        // Exhaustiveness guard (see handleSystemMessage): new SDK top-level
        // message types fail typecheck here instead of warning at runtime.
        message satisfies never;
        const unknownMessage = readSdkRecord(message);
        yield* emitRuntimeWarning(
          context,
          describeUnknownSdkMessage(`Claude SDK message '${unknownMessage?.type}'`, message),
          message,
        );

        return;
      }
    }
  });

  const { runSdkStream, handleStreamExit, stopSessionInternal } = createClaudeStreamLifecycle({
    handleSdkMessage,
    completeTurn,
    emitRuntimeError,
    makeEventStamp,
    offerRuntimeEvent,
    nowIso,
    sessions,
  });

  const requireSession = (
    threadId: ThreadId,
  ): Effect.Effect<ClaudeSessionContext, ProviderAdapterError> => {
    const context = sessions.get(threadId);

    if (!context) {
      return Effect.fail(
        new ProviderAdapterSessionNotFoundError({
          provider: PROVIDER,
          threadId,
        }),
      );
    }

    if (context.stopped || context.session.status === "closed") {
      return Effect.fail(
        new ProviderAdapterSessionClosedError({
          provider: PROVIDER,
          threadId,
        }),
      );
    }

    return Effect.succeed(context);
  };

  const { startSession } = createClaudeSessionLifecycle({
    sessions,
    stopSessionInternal,
    nowIso,
    randomUUIDv4,
    makeEventStamp,
    offerRuntimeEvent,
    emitProposedPlanCompleted,
    claudeSdkExecutablePath,
    claudeSettings,
    boundInstanceId,
    serverConfig,
    claudeEnvironment,
    fileSystem,
    path,
    createQuery,
    runSdkStream,
    handleStreamExit,
  });

  const sendTurn: ClaudeAdapterShape["sendTurn"] = Effect.fn("sendTurn")(function* (input) {
    const context = yield* requireSession(input.threadId);

    const modelSelection =
      input.modelSelection !== undefined && input.modelSelection.instanceId === boundInstanceId
        ? input.modelSelection
        : undefined;

    // A sendTurn while a real turn is running is a steer: the message is
    // queued into the live SDK agent loop and the work continues as the same
    // turn — no synthetic turn boundary. Stale synthetic turns (from
    // background agent responses between user prompts) are auto-closed
    // instead, so they don't block the user's next turn.
    const steeringTurnState =
      context.turnState && context.turnState.synthetic !== true ? context.turnState : null;

    if (context.turnState && steeringTurnState === null) {
      yield* completeTurn(context, "completed");
    }

    if (modelSelection?.model) {
      const apiModelId = resolveClaudeApiModelId(modelSelection);

      if (context.currentApiModelId !== apiModelId) {
        yield* Effect.tryPromise({
          try: () => context.query.setModel(apiModelId),
          catch: (cause) => toRequestError(input.threadId, "turn/setModel", cause),
        });
        context.currentApiModelId = apiModelId;
      }

      context.session = {
        ...context.session,
        model: modelSelection.model,
      };
      const turnCaps = getClaudeModelCapabilities(modelSelection.model);

      const turnEffort = resolveClaudeEffort(
        turnCaps,
        getModelSelectionStringOptionValue(modelSelection, "effort"),
      );

      context.currentEffort =
        getEffectiveClaudeAgentEffort(turnEffort ?? null, modelSelection.model) ?? undefined;
    }

    // Plan mode is retired. "default" restores the session's original
    // permission mode (a session resumed from plan mode leaves it); when
    // interactionMode is absent the current mode is left unchanged.
    if (input.interactionMode !== undefined) {
      yield* Effect.tryPromise({
        try: () => context.query.setPermissionMode(context.basePermissionMode ?? "default"),
        catch: (cause) => toRequestError(input.threadId, "turn/setPermissionMode", cause),
      });
    }

    const turnId = steeringTurnState?.turnId ?? TurnId.make(yield* randomUUIDv4);

    if (steeringTurnState === null) {
      const turnState: ClaudeTurnState = createClaudeTurnState(turnId, yield* nowIso);

      const updatedAt = yield* nowIso;
      context.turnState = turnState;
      context.session = {
        ...context.session,
        status: "running",
        activeTurnId: turnId,
        updatedAt,
      };

      const turnStartedStamp = yield* makeEventStamp();
      yield* offerRuntimeEvent({
        type: "turn.started",
        eventId: turnStartedStamp.eventId,
        provider: PROVIDER,
        createdAt: turnStartedStamp.createdAt,
        threadId: context.session.threadId,
        turnId,
        payload: modelSelection?.model ? { model: modelSelection.model } : {},
        providerRefs: {},
      });
    }

    const skills = yield* discoverClaudeSkills(
      claudeSettings,
      context.session.cwd,
      claudeEnvironment,
    ).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
    );

    const message = yield* buildUserMessageEffect(input, {
      fileSystem,
      attachmentsDir: serverConfig.attachmentsDir,
      boundInstanceId,
      skillNames: new Set(skills.filter((skill) => skill.enabled).map((skill) => skill.name)),
    });

    yield* Queue.offer(context.promptQueue, {
      type: "message",
      message,
    }).pipe(Effect.mapError((cause) => toRequestError(input.threadId, "turn/start", cause)));

    return {
      threadId: context.session.threadId,
      turnId,
      ...(context.session.resumeCursor !== undefined
        ? { resumeCursor: context.session.resumeCursor }
        : {}),
    };
  });

  const interruptTurn: ClaudeAdapterShape["interruptTurn"] = Effect.fn("interruptTurn")(
    function* (threadId, _turnId) {
      const context = yield* requireSession(threadId);
      // interrupt() can acknowledge while resumed background tasks keep the
      // CLI alive. Stop is a hard session boundary for Claude, so close the
      // query and let the SDK escalate to SIGKILL when graceful exit fails.
      yield* stopSessionInternal(context);
    },
  );

  const readThread: ClaudeAdapterShape["readThread"] = Effect.fn("readThread")(
    function* (threadId) {
      const context = yield* requireSession(threadId);

      return yield* snapshotThread(context);
    },
  );

  const rollbackThread: ClaudeAdapterShape["rollbackThread"] = Effect.fn("rollbackThread")(
    function* (threadId, numTurns) {
      const context = yield* requireSession(threadId);
      const nextLength = Math.max(0, context.turns.length - numTurns);
      context.turns.splice(nextLength);
      yield* updateResumeCursor(context);

      return yield* snapshotThread(context);
    },
  );

  const respondToRequest: ClaudeAdapterShape["respondToRequest"] = Effect.fn("respondToRequest")(
    function* (threadId, requestId, decision) {
      const context = yield* requireSession(threadId);
      const pending = context.pendingApprovals.get(requestId);

      if (!pending) {
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "item/requestApproval/decision",
          detail: `Unknown pending approval request: ${requestId}`,
        });
      }

      context.pendingApprovals.delete(requestId);
      yield* Deferred.succeed(pending.decision, decision);
    },
  );

  const respondToUserInput: ClaudeAdapterShape["respondToUserInput"] = Effect.fn(
    "respondToUserInput",
  )(function* (threadId, requestId, answers) {
    const context = yield* requireSession(threadId);
    const pending = context.pendingUserInputs.get(requestId);

    if (!pending) {
      return yield* new ProviderAdapterRequestError({
        provider: PROVIDER,
        method: "item/tool/respondToUserInput",
        detail: `Unknown pending user-input request: ${requestId}`,
      });
    }

    context.pendingUserInputs.delete(requestId);
    yield* Deferred.succeed(pending.answers, answers);
  });

  const stopSession: ClaudeAdapterShape["stopSession"] = Effect.fn("stopSession")(
    function* (threadId) {
      const context = yield* requireSession(threadId);
      yield* stopSessionInternal(context, {
        emitExitEvent: true,
      });
    },
  );

  const listSessions: ClaudeAdapterShape["listSessions"] = () =>
    Effect.sync(() => Array.from(sessions.values(), ({ session }) => ({ ...session })));

  const hasSession: ClaudeAdapterShape["hasSession"] = (threadId) =>
    Effect.sync(() => {
      const context = sessions.get(threadId);

      return context !== undefined && !context.stopped;
    });

  const stopSessions = Effect.fn("stopSessions")(function* (
    contexts: ReadonlyArray<ClaudeSessionContext>,
    emitExitEvent: boolean,
  ) {
    const results = yield* Effect.forEach(contexts, (context) =>
      stopSessionInternal(context, { emitExitEvent }).pipe(Effect.result),
    );

    for (const result of results) {
      if (Predicate.isTagged(result, "Failure")) {
        return yield* Effect.fail(result.failure);
      }
    }
  });

  const stopAll: ClaudeAdapterShape["stopAll"] = () =>
    stopSessions(Array.from(sessions.values()), true);

  yield* Effect.addFinalizer(() =>
    stopSessions(Array.from(sessions.values()), false).pipe(
      Effect.catch((cause) =>
        Effect.logError("Failed to emit Claude session shutdown event.", { cause }),
      ),
      Effect.tap(() => Queue.shutdown(runtimeEventQueue)),
      Effect.tap(() => managedNativeEventLogger?.close() ?? Effect.void),
    ),
  );

  return {
    provider: PROVIDER,
    capabilities: {
      sessionModelSwitch: "in-session",
    },
    startSession,
    sendTurn,
    interruptTurn,
    readThread,
    rollbackThread,
    respondToRequest,
    respondToUserInput,
    stopSession,
    listSessions,
    hasSession,
    stopAll,
    get streamEvents() {
      return Stream.fromQueue(runtimeEventQueue);
    },
  } satisfies ClaudeAdapterShape;
});
