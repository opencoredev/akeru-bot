import type { SdkRecord } from "../ProtocolJson.ts";
import { isSdkRecord, readSdkRecord } from "../ProtocolJson.ts";
import * as Predicate from "effect/Predicate";
import {
  type CanUseTool,
  type Options as ClaudeQueryOptions,
  type PermissionResult,
} from "@anthropic-ai/claude-agent-sdk";
import {
  ApprovalRequestId,
  type EventId,
  type ProviderApprovalDecision,
  type ProviderRuntimeEvent,
  type ProviderUserInputAnswers,
  type RuntimeMode,
  type UserInputQuestion,
} from "@akeru/contracts";
import {
  CLAUDE_RESUME_COMPACTION_NEVER_ANSWER,
  formatClaudeResumeCompactionQuestion,
} from "@akeru/shared/claudeCompaction";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import { type ProviderAdapterRequestError } from "../../Errors.ts";
import {
  PROVIDER,
  type ClaudeSessionContext,
  type PendingApproval,
  type PendingUserInput,
} from "./ClaudeAdapterState.ts";
import {
  asCanonicalTurnId,
  asRuntimeRequestId,
  classifyRequestType,
  extractExitPlanModePlan,
  nativeProviderRefs,
  summarizeToolRequest,
  toSessionPermissionUpdates,
} from "./ClaudeProtocolValues.ts";
import { finiteNonNegativeInteger } from "./ClaudeUsage.ts";

/**
 * Per-session SDK callbacks for tool permission prompts, AskUserQuestion,
 * plan capture, and the resume-compaction dialog. Each one surfaces a runtime
 * request event and waits on a Deferred that `respondToRequest` or
 * `respondToUserInput` settles.
 */
export function createClaudeSessionPermissions(deps: {
  readonly runtimeMode: RuntimeMode | undefined;
  readonly contextRef: Ref.Ref<ClaudeSessionContext | undefined>;
  readonly pendingApprovals: Map<ApprovalRequestId, PendingApproval>;
  readonly pendingUserInputs: Map<ApprovalRequestId, PendingUserInput>;
  readonly runFork: ReturnType<typeof Effect.runForkWith<never>>;
  readonly runPromise: ReturnType<typeof Effect.runPromiseWith<never>>;
  readonly randomUUIDv4: Effect.Effect<string, ProviderAdapterRequestError, never>;
  readonly makeEventStamp: () => Effect.Effect<
    { eventId: EventId; createdAt: string },
    ProviderAdapterRequestError,
    never
  >;
  readonly offerRuntimeEvent: (event: ProviderRuntimeEvent) => Effect.Effect<void>;
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
}) {
  const { contextRef, pendingApprovals, pendingUserInputs, runFork, runPromise } = deps;

  /**
   * Handle AskUserQuestion tool calls by emitting a `user-input.requested`
   * runtime event and waiting for the user to respond via `respondToUserInput`.
   */
  const handleAskUserQuestion = Effect.fn("handleAskUserQuestion")(function* (
    context: ClaudeSessionContext,
    toolInput: SdkRecord,
    callbackOptions: {
      readonly signal: AbortSignal;
      readonly toolUseID?: string;
    },
  ) {
    const requestId = ApprovalRequestId.make(yield* deps.randomUUIDv4);

    // Parse questions from the SDK's AskUserQuestion input.
    // `id` MUST equal the full question text — Claude SDK >= 2.1.121 looks
    // up answers by question text in `mapToolResultToToolResultBlockParam`,
    // so the key the UI uses to keep its draft answer must match the SDK's
    // expected lookup key. See https://github.com/pingdotgg/t3code/issues/2388
    const rawQuestions = Array.isArray(toolInput.questions) ? toolInput.questions : [];

    const questions: Array<UserInputQuestion> = rawQuestions.map((q: SdkRecord, idx: number) => ({
      id: Predicate.isString(q.question) && q.question.length > 0 ? q.question : `q-${idx}`,
      header: Predicate.isString(q.header) ? q.header : `Question ${idx + 1}`,
      question: Predicate.isString(q.question) ? q.question : "",
      options: Array.isArray(q.options)
        ? q.options.map((opt: SdkRecord) => ({
            label: Predicate.isString(opt.label) ? opt.label : "",
            description: Predicate.isString(opt.description) ? opt.description : "",
          }))
        : [],
      multiSelect: Predicate.isBoolean(q.multiSelect) ? q.multiSelect : false,
    }));

    const answersDeferred = yield* Deferred.make<ProviderUserInputAnswers>();
    let aborted = false;

    const settleAsAborted = Effect.suspend(() => {
      if (!pendingUserInputs.has(requestId)) {
        return Effect.void;
      }

      aborted = true;
      pendingUserInputs.delete(requestId);

      return Deferred.succeed(answersDeferred, {}).pipe(Effect.ignore);
    });

    const pendingInput: PendingUserInput = {
      questions,
      answers: answersDeferred,
      cancel: settleAsAborted,
    };

    // Emit user-input.requested so the UI can present the questions.
    const requestedStamp = yield* deps.makeEventStamp();
    yield* deps.offerRuntimeEvent({
      type: "user-input.requested",
      eventId: requestedStamp.eventId,
      provider: PROVIDER,
      createdAt: requestedStamp.createdAt,
      threadId: context.session.threadId,
      ...(context.turnState
        ? {
            turnId: asCanonicalTurnId(context.turnState.turnId),
          }
        : {}),
      requestId: asRuntimeRequestId(requestId),
      payload: { questions },
      providerRefs: nativeProviderRefs(context, {
        providerItemId: callbackOptions.toolUseID,
      }),
      raw: {
        source: "claude.sdk.permission",
        method: "canUseTool/AskUserQuestion",
        payload: {
          toolName: "AskUserQuestion",
          input: toolInput,
        },
      },
    });

    pendingUserInputs.set(requestId, pendingInput);

    // Handle abort (e.g. turn interrupted while waiting for user input).
    const onAbort = () => {
      runFork(settleAsAborted);
    };

    callbackOptions.signal.addEventListener("abort", onAbort, {
      once: true,
    });

    // The signal may have aborted during the awaited event emissions
    // above, before the listener existed; settle now so the dialog
    // cannot hang with a lingering pending question.
    if (callbackOptions.signal.aborted) {
      yield* settleAsAborted;
    }

    // Block until the user provides answers.
    const answers = yield* Deferred.await(answersDeferred);
    pendingUserInputs.delete(requestId);

    // Emit user-input.resolved so the UI knows the interaction completed.
    const resolvedStamp = yield* deps.makeEventStamp();
    yield* deps.offerRuntimeEvent({
      type: "user-input.resolved",
      eventId: resolvedStamp.eventId,
      provider: PROVIDER,
      createdAt: resolvedStamp.createdAt,
      threadId: context.session.threadId,
      ...(context.turnState
        ? {
            turnId: asCanonicalTurnId(context.turnState.turnId),
          }
        : {}),
      requestId: asRuntimeRequestId(requestId),
      payload: { answers },
      providerRefs: nativeProviderRefs(context, {
        providerItemId: callbackOptions.toolUseID,
      }),
      raw: {
        source: "claude.sdk.permission",
        method: "canUseTool/AskUserQuestion/resolved",
        payload: { answers },
      },
    });

    if (aborted) {
      return {
        behavior: "deny",
        message: "User cancelled tool execution.",
      } satisfies PermissionResult;
    }

    // Return the answers to the SDK in the expected format:
    // { questions: [...], answers: { questionText: selectedLabel } }
    return {
      behavior: "allow",
      updatedInput: {
        questions: toolInput.questions,
        answers,
      },
    } satisfies PermissionResult;
  });

  const handleResumeDialog = Effect.fn("handleResumeDialog")(function* (
    request: Parameters<NonNullable<ClaudeQueryOptions["onUserDialog"]>>[0],
    callbackOptions: Parameters<NonNullable<ClaudeQueryOptions["onUserDialog"]>>[1],
  ) {
    if (request.dialogKind !== "resume_return") {
      return { behavior: "cancelled" as const };
    }

    const context = yield* Ref.get(contextRef);

    if (!context) {
      return { behavior: "cancelled" as const };
    }

    // The question copy lives in @akeru/shared/claudeCompaction because
    // the web client recognizes this exact text (and the "never" answer)
    // to mirror a permanent dismissal.
    const question = formatClaudeResumeCompactionQuestion({
      ageMinutes: finiteNonNegativeInteger(request.payload.sessionAgeMinutes) ?? 0,
      estimatedTokens: finiteNonNegativeInteger(request.payload.estimatedTokens) ?? 0,
    });

    const result = yield* handleAskUserQuestion(
      context,
      {
        questions: [
          {
            header: "Resume session",
            question,
            options: [
              {
                label: "Compact and continue",
                description: "Resume with a summary and use fewer tokens.",
              },
              {
                label: "Keep full history",
                description: "Resume without changing the conversation.",
              },
              {
                label: CLAUDE_RESUME_COMPACTION_NEVER_ANSWER,
                description: "Keep full history and skip future resume prompts.",
              },
            ],
            multiSelect: false,
          },
        ],
      },
      {
        signal: callbackOptions.signal,
        ...(request.toolUseID ? { toolUseID: request.toolUseID } : {}),
      },
    );

    if (result.behavior !== "allow") {
      return { behavior: "cancelled" as const };
    }

    const answers = result.updatedInput.answers;

    const selection =
      answers && isSdkRecord(answers) && !Array.isArray(answers) ? answers[question] : undefined;

    const action =
      selection === "Compact and continue"
        ? "compact"
        : selection === CLAUDE_RESUME_COMPACTION_NEVER_ANSWER
          ? "never"
          : "continue";

    return { behavior: "completed" as const, result: action };
  });

  const canUseToolEffect = Effect.fn("canUseTool")(function* (
    toolName: Parameters<CanUseTool>[0],
    toolInput: Parameters<CanUseTool>[1],
    callbackOptions: Parameters<CanUseTool>[2],
  ) {
    const context = yield* Ref.get(contextRef);

    if (!context) {
      return {
        behavior: "deny",
        message: "Claude session context is unavailable.",
      } satisfies PermissionResult;
    }

    // Handle AskUserQuestion: surface clarifying questions to the
    // user via the user-input runtime event channel, regardless of
    // runtime mode (plan mode relies on this heavily).
    if (toolName === "AskUserQuestion") {
      return yield* handleAskUserQuestion(context, readSdkRecord(toolInput) ?? {}, callbackOptions);
    }

    if (toolName === "ExitPlanMode") {
      const planMarkdown = extractExitPlanModePlan(toolInput);

      if (planMarkdown) {
        yield* deps.emitProposedPlanCompleted(context, {
          planMarkdown,
          toolUseId: callbackOptions.toolUseID,
          rawSource: "claude.sdk.permission",
          rawMethod: "canUseTool/ExitPlanMode",
          rawPayload: {
            toolName,
            input: toolInput,
          },
        });
      }

      return {
        behavior: "deny",
        message:
          "The client captured your proposed plan. Stop here and wait for the user's feedback or implementation request in a later turn.",
      } satisfies PermissionResult;
    }

    const runtimeMode = deps.runtimeMode ?? "full-access";

    if (runtimeMode === "full-access") {
      return {
        behavior: "allow",
        updatedInput: toolInput,
      } satisfies PermissionResult;
    }

    const requestId = ApprovalRequestId.make(yield* deps.randomUUIDv4);
    const requestType = classifyRequestType(toolName);
    const detail = summarizeToolRequest(toolName, readSdkRecord(toolInput) ?? {});
    const decisionDeferred = yield* Deferred.make<ProviderApprovalDecision>();

    const pendingApproval: PendingApproval = {
      requestType,
      detail,
      decision: decisionDeferred,
      ...(callbackOptions.suggestions ? { suggestions: callbackOptions.suggestions } : {}),
    };

    const requestedStamp = yield* deps.makeEventStamp();
    yield* deps.offerRuntimeEvent({
      type: "request.opened",
      eventId: requestedStamp.eventId,
      provider: PROVIDER,
      createdAt: requestedStamp.createdAt,
      threadId: context.session.threadId,
      ...(context.turnState ? { turnId: asCanonicalTurnId(context.turnState.turnId) } : {}),
      requestId: asRuntimeRequestId(requestId),
      payload: {
        requestType,
        detail,
      },
      providerRefs: nativeProviderRefs(context, {
        providerItemId: callbackOptions.toolUseID,
      }),
      raw: {
        source: "claude.sdk.permission",
        method: "canUseTool/request",
        payload: {
          toolName,
          input: toolInput,
        },
      },
    });

    pendingApprovals.set(requestId, pendingApproval);

    const onAbort = () => {
      if (!pendingApprovals.has(requestId)) {
        return;
      }

      pendingApprovals.delete(requestId);
      runFork(Deferred.succeed(decisionDeferred, "cancel"));
    };

    callbackOptions.signal.addEventListener("abort", onAbort, {
      once: true,
    });

    // Same late-listener race as handleAskUserQuestion: the signal may
    // have aborted while the request event emissions were awaited.
    if (callbackOptions.signal.aborted) {
      onAbort();
    }

    const decision = yield* Deferred.await(decisionDeferred);
    pendingApprovals.delete(requestId);

    const resolvedStamp = yield* deps.makeEventStamp();
    yield* deps.offerRuntimeEvent({
      type: "request.resolved",
      eventId: resolvedStamp.eventId,
      provider: PROVIDER,
      createdAt: resolvedStamp.createdAt,
      threadId: context.session.threadId,
      ...(context.turnState ? { turnId: asCanonicalTurnId(context.turnState.turnId) } : {}),
      requestId: asRuntimeRequestId(requestId),
      payload: {
        requestType,
        decision,
      },
      providerRefs: nativeProviderRefs(context, {
        providerItemId: callbackOptions.toolUseID,
      }),
      raw: {
        source: "claude.sdk.permission",
        method: "canUseTool/decision",
        payload: {
          decision,
        },
      },
    });

    if (decision === "accept" || decision === "acceptForSession") {
      return {
        behavior: "allow",
        updatedInput: toolInput,
        ...(decision === "acceptForSession"
          ? {
              updatedPermissions: toSessionPermissionUpdates(toolName, pendingApproval.suggestions),
            }
          : {}),
      } satisfies PermissionResult;
    }

    return {
      behavior: "deny",
      message:
        decision === "cancel" ? "User cancelled tool execution." : "User declined tool execution.",
    } satisfies PermissionResult;
  });

  const canUseTool: CanUseTool = (toolName, toolInput, callbackOptions) =>
    runPromise(canUseToolEffect(toolName, toolInput, callbackOptions));

  const onUserDialog: NonNullable<ClaudeQueryOptions["onUserDialog"]> = (
    request,
    callbackOptions,
  ) => runPromise(handleResumeDialog(request, callbackOptions));

  return { canUseTool, onUserDialog };
}
