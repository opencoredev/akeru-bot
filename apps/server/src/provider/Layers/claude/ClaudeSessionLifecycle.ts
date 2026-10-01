import { readProtocolRecord } from "../ProtocolJson.ts";
import { isProtocolRecord } from "../ProtocolJson.ts";
import * as Schema from "effect/Schema";
import * as Predicate from "effect/Predicate";
// @effect-diagnostics globalDate:off globalConsole:off globalRandom:off nodeBuiltinImport:off globalTimers:off globalFetch:off
/**
 * ClaudeAdapterLive - Scoped live implementation for the Claude Agent provider adapter.
 *
 * Wraps `@anthropic-ai/claude-agent-sdk` query sessions behind the generic
 * provider adapter contract and emits canonical runtime events.
 *
 * @module ClaudeAdapterLive
 */
import {
  type CanUseTool,
  type Options as ClaudeQueryOptions,
  type PermissionMode,
  type PermissionResult,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { parseCliArgs } from "@akeru/shared/cliArgs";
import {
  ApprovalRequestId,
  type ClaudeSettings,
  EventId,
  type ProviderApprovalDecision,
  ProviderInstanceId,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ProviderUserInputAnswers,
  ThreadId,
  type UserInputQuestion,
} from "@akeru/contracts";
import {
  getModelSelectionBooleanOptionValue,
  getModelSelectionStringOptionValue,
  getProviderOptionDescriptors,
} from "@akeru/shared/model";
import {
  CLAUDE_RESUME_COMPACTION_NEVER_ANSWER,
  formatClaudeResumeCompactionQuestion,
} from "@akeru/shared/claudeCompaction";
import * as Cause from "effect/Cause";

import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { ServerConfig } from "../../../config.ts";
import { subscriptionRuntimeEnvironment } from "../../../subscription-auth/runtime.ts";
import {
  createAkeruAgentInstructions,
  createAkeruBotInstructions,
} from "../../AkeruAgentInstructions.ts";
import * as McpProviderSession from "../../../mcp/McpProviderSession.ts";
import { toClaudeMcpServers } from "../../McpServerConfig.ts";

import {
  getClaudeModelCapabilities,
  isClaudeUltracodeEffort,
  resolveClaudeApiModelId,
  resolveClaudeEffort,
} from "./ClaudeModels.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterValidationError,
} from "../../Errors.ts";
import { type ClaudeAdapterShape } from "../../Services/ClaudeAdapter.ts";

import {
  PROVIDER,
  type PromptQueueItem,
  type PendingApproval,
  type PendingUserInput,
  type ToolInFlight,
  type ClaudeTaskState,
  type ClaudeTaskAgentState,
  type ClaudeSessionContext,
  type ClaudeQueryRuntime,
} from "./ClaudeAdapterState.ts";
import {
  encodeJsonStringForDiagnostics,
  toSessionPermissionUpdates,
  getEffectiveClaudeAgentEffort,
  asCanonicalTurnId,
  asRuntimeRequestId,
  readClaudeResumeState,
  classifyRequestType,
  summarizeToolRequest,
  nativeProviderRefs,
  extractExitPlanModePlan,
} from "./ClaudeProtocolValues.ts";

import { selectedClaudeContextWindow, finiteNonNegativeInteger } from "./ClaudeUsage.ts";
import { CLAUDE_SETTING_SOURCES } from "./ClaudePrompt.ts";

export function createClaudeSessionLifecycle(deps: {
  readonly sessions: Map<ThreadId, ClaudeSessionContext>;
  readonly stopSessionInternal: (
    context: ClaudeSessionContext,
    options?: { readonly emitExitEvent?: boolean } | undefined,
  ) => Effect.Effect<void, ProviderAdapterRequestError | ProviderAdapterProcessError, never>;
  readonly nowIso: Effect.Effect<string, never, never>;
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
  readonly claudeSdkExecutablePath: string;
  readonly claudeSettings: ClaudeSettings;
  readonly boundInstanceId: ProviderInstanceId;
  readonly serverConfig: ServerConfig["Service"];
  readonly claudeEnvironment: NodeJS.ProcessEnv;
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: Path.Path;
  readonly createQuery: (input: {
    readonly prompt: AsyncIterable<SDKUserMessage>;
    readonly options: ClaudeQueryOptions;
  }) => ClaudeQueryRuntime;
  readonly runSdkStream: (
    context: ClaudeSessionContext,
  ) => Effect.Effect<void, ProviderAdapterProcessError>;
  readonly handleStreamExit: (
    context: ClaudeSessionContext,
    exit: Exit.Exit<void, ProviderAdapterProcessError>,
  ) => Effect.Effect<void, ProviderAdapterRequestError | ProviderAdapterProcessError, never>;
}) {
  const startSession: ClaudeAdapterShape["startSession"] = Effect.fn("startSession")(
    function* (input) {
      if (input.provider !== undefined && input.provider !== PROVIDER) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "startSession",
          issue: `Expected provider '${PROVIDER}' but received '${input.provider}'.`,
        });
      }

      const existingContext = deps.sessions.get(input.threadId);

      if (existingContext) {
        yield* Effect.logWarning("claude.session.replacing", {
          threadId: input.threadId,
          existingSessionStatus: existingContext.session.status,
          reason: "startSession called with existing active session",
        });
        yield* deps.stopSessionInternal(existingContext, {
          emitExitEvent: false,
        });
      }

      const startedAt = yield* deps.nowIso;
      const resumeState = readClaudeResumeState(input.resumeCursor);
      const threadId = input.threadId;
      const existingResumeSessionId = resumeState?.resume;

      const newSessionId =
        existingResumeSessionId === undefined ? yield* deps.randomUUIDv4 : undefined;

      const sessionId = existingResumeSessionId ?? newSessionId;

      const runtimeContext = yield* Effect.context<never>();
      const runFork = Effect.runForkWith(runtimeContext);
      const runPromise = Effect.runPromiseWith(runtimeContext);

      const promptQueue = yield* Queue.unbounded<PromptQueueItem>();

      const prompt = Stream.fromQueue(promptQueue).pipe(
        Stream.filter((item) => item.type === "message"),
        Stream.map((item) => item.message),
        Stream.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause) ? Stream.empty : Stream.failCause(cause),
        ),
        Stream.toAsyncIterable,
      );

      const pendingApprovals = new Map<ApprovalRequestId, PendingApproval>();
      const pendingUserInputs = new Map<ApprovalRequestId, PendingUserInput>();
      const inFlightTools = new Map<number, ToolInFlight>();
      const claudeTasks = new Map<string, ClaudeTaskState>();
      const taskAgents = new Map<string, ClaudeTaskAgentState>();
      const pendingTaskModels = new Map<string, string>();
      const workflowMemberFingerprints = new Map<string, string>();
      const liveTaskIds = new Set<string>();

      const contextRef = yield* Ref.make<ClaudeSessionContext | undefined>(undefined);

      /**
       * Handle AskUserQuestion tool calls by emitting a `user-input.requested`
       * runtime event and waiting for the user to respond via `respondToUserInput`.
       */
      const handleAskUserQuestion = Effect.fn("handleAskUserQuestion")(function* (
        context: ClaudeSessionContext,
        toolInput: Schema.JsonObject,
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

        const questions: Array<UserInputQuestion> = rawQuestions.map(
          (q: Schema.JsonObject, idx: number) => ({
            id: Predicate.isString(q.question) && q.question.length > 0 ? q.question : `q-${idx}`,
            header: Predicate.isString(q.header) ? q.header : `Question ${idx + 1}`,
            question: Predicate.isString(q.question) ? q.question : "",
            options: Array.isArray(q.options)
              ? q.options.map((opt: Schema.JsonObject) => ({
                  label: Predicate.isString(opt.label) ? opt.label : "",
                  description: Predicate.isString(opt.description) ? opt.description : "",
                }))
              : [],
            multiSelect: Predicate.isBoolean(q.multiSelect) ? q.multiSelect : false,
          }),
        );

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
          answers && isProtocolRecord(answers) && !Array.isArray(answers)
            ? answers[question]
            : undefined;

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
          return yield* handleAskUserQuestion(
            context,
            readProtocolRecord(toolInput) ?? {},
            callbackOptions,
          );
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

        const runtimeMode = input.runtimeMode ?? "full-access";

        if (runtimeMode === "full-access") {
          return {
            behavior: "allow",
            updatedInput: toolInput,
          } satisfies PermissionResult;
        }

        const requestId = ApprovalRequestId.make(yield* deps.randomUUIDv4);
        const requestType = classifyRequestType(toolName);
        const detail = summarizeToolRequest(toolName, readProtocolRecord(toolInput) ?? {});
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
                  updatedPermissions: toSessionPermissionUpdates(
                    toolName,
                    pendingApproval.suggestions,
                  ),
                }
              : {}),
          } satisfies PermissionResult;
        }

        return {
          behavior: "deny",
          message:
            decision === "cancel"
              ? "User cancelled tool execution."
              : "User declined tool execution.",
        } satisfies PermissionResult;
      });

      const canUseTool: CanUseTool = (toolName, toolInput, callbackOptions) =>
        runPromise(canUseToolEffect(toolName, toolInput, callbackOptions));

      const onUserDialog: NonNullable<ClaudeQueryOptions["onUserDialog"]> = (
        request,
        callbackOptions,
      ) => runPromise(handleResumeDialog(request, callbackOptions));

      const claudeBinaryPath = deps.claudeSdkExecutablePath;
      const extraArgs = parseCliArgs(deps.claudeSettings.launchArgs).flags;

      const modelSelection =
        input.modelSelection?.instanceId === deps.boundInstanceId
          ? input.modelSelection
          : undefined;

      const caps = getClaudeModelCapabilities(modelSelection?.model);
      const descriptors = getProviderOptionDescriptors({ caps });
      const apiModelId = modelSelection ? resolveClaudeApiModelId(modelSelection) : undefined;
      const initialContextWindow = selectedClaudeContextWindow(modelSelection);
      const rawEffort = getModelSelectionStringOptionValue(modelSelection, "effort");
      const effort = resolveClaudeEffort(caps, rawEffort) ?? null;

      const fastModeSupported = descriptors.some(
        (descriptor) => descriptor.type === "boolean" && descriptor.id === "fastMode",
      );

      const thinkingSupported = descriptors.some(
        (descriptor) => descriptor.type === "boolean" && descriptor.id === "thinking",
      );

      const fastMode =
        getModelSelectionBooleanOptionValue(modelSelection, "fastMode") === true &&
        fastModeSupported;

      const thinking = thinkingSupported
        ? getModelSelectionBooleanOptionValue(modelSelection, "thinking")
        : undefined;

      const ultracode = isClaudeUltracodeEffort(effort);
      const effectiveEffort = getEffectiveClaudeAgentEffort(effort, modelSelection?.model);

      const runtimeModeToPermission = {
        "auto-accept-edits": "acceptEdits",
        auto: "auto",
        "full-access": "bypassPermissions",
      } satisfies Record<
        Exclude<ProviderSession["runtimeMode"], "approval-required">,
        PermissionMode
      >;

      const permissionMode =
        input.runtimeMode === "approval-required"
          ? undefined
          : runtimeModeToPermission[input.runtimeMode];

      const settings = {
        ...(Predicate.isBoolean(thinking) ? { alwaysThinkingEnabled: thinking } : {}),
        ...(fastMode ? { fastMode: true } : {}),
        ...(ultracode ? { ultracode: true } : {}),
        ...(deps.claudeSettings.autoCompactWindow
          ? { autoCompactWindow: Number(deps.claudeSettings.autoCompactWindow) }
          : {}),
      };

      const mcpSession = McpProviderSession.readMcpProviderSession(input.threadId);

      const mcpServers = {
        ...toClaudeMcpServers(input.mcpServers ?? []),
        ...(mcpSession
          ? {
              akeru: {
                type: "http" as const,
                url: mcpSession.endpoint,
                headers: { Authorization: mcpSession.authorizationHeader },
              },
            }
          : {}),
      };

      // The attachments dir grant lets the agent Read/copy pasted images at
      // the paths ProviderService injects into the turn text, without an
      // approval prompt. It is a leaf directory holding only attachment
      // files; siblings like secrets/ and state.sqlite stay ungranted.
      const additionalDirectories = [
        ...(input.cwd ? [input.cwd] : []),
        deps.serverConfig.attachmentsDir,
      ];

      const queryOptions: ClaudeQueryOptions = {
        ...(input.cwd ? { cwd: input.cwd } : {}),
        ...(apiModelId ? { model: apiModelId } : {}),
        pathToClaudeCodeExecutable: claudeBinaryPath,
        systemPrompt: {
          type: "preset",
          preset: "claude_code",
          append: input.botId
            ? createAkeruBotInstructions({
                ...(input.botName ? { name: input.botName } : {}),
                ...(input.personalityTone !== undefined
                  ? { personalityTone: input.personalityTone }
                  : {}),
              })
            : createAkeruAgentInstructions(),
        },
        settingSources: [...CLAUDE_SETTING_SOURCES],
        // `ultracode` is a Claude Code setting, not an API effort level. It is
        // normalized to `xhigh` above and paired with `settings.ultracode`.
        ...(effectiveEffort
          ? {
              effort: effectiveEffort,
            }
          : {}),
        ...(permissionMode ? { permissionMode } : {}),
        ...(permissionMode === "bypassPermissions"
          ? { allowDangerouslySkipPermissions: true }
          : {}),
        ...(Object.keys(settings).length > 0 ? { settings } : {}),
        ...(existingResumeSessionId ? { resume: existingResumeSessionId } : {}),
        ...(newSessionId ? { sessionId: newSessionId } : {}),
        includePartialMessages: true,
        canUseTool,
        onUserDialog,
        supportedDialogKinds: ["resume_return"],
        env: yield* subscriptionRuntimeEnvironment(
          deps.serverConfig.secretsDir,
          "anthropic",
          deps.claudeEnvironment,
          deps.boundInstanceId,
        ).pipe(
          Effect.provideService(FileSystem.FileSystem, deps.fileSystem),
          Effect.provideService(Path.Path, deps.path),
        ),
        additionalDirectories,
        ...(Object.keys(extraArgs).length > 0 ? { extraArgs } : {}),
        ...(Object.keys(mcpServers).length > 0 ? { mcpServers } : {}),
      };

      yield* Effect.annotateCurrentSpan({
        "provider.kind": PROVIDER,
        "provider.thread_id": threadId,
        "provider.runtime_mode": input.runtimeMode,
        "claude.resume.source":
          existingResumeSessionId !== undefined ? "resume-session" : "generated-session",
        "claude.resume.thread_id": resumeState?.threadId ?? "",
        "claude.resume.session_id": existingResumeSessionId ?? "",
        "claude.resume.session_at": resumeState?.resumeSessionAt ?? "",
        "claude.resume.turn_count": resumeState?.turnCount ?? -1,
        "claude.query.cwd": input.cwd ?? "",
        "claude.query.model": apiModelId ?? "",
        "claude.query.effort": effectiveEffort ?? "",
        "claude.query.permission_mode": permissionMode ?? "",
        "claude.query.allow_dangerously_skip_permissions": permissionMode === "bypassPermissions",
        "claude.query.resume": existingResumeSessionId ?? "",
        "claude.query.session_id": newSessionId ?? "",
        "claude.query.include_partial_messages": true,
        "claude.query.additional_directories": additionalDirectories,
        "claude.query.setting_sources": [...CLAUDE_SETTING_SOURCES],
        "claude.query.settings_json": encodeJsonStringForDiagnostics(settings) ?? "",
        "claude.query.extra_args_json": encodeJsonStringForDiagnostics(extraArgs) ?? "",
        "claude.query.path_to_executable": claudeBinaryPath,
      });

      const queryRuntime = yield* Effect.try({
        try: () =>
          deps.createQuery({
            prompt,
            options: queryOptions,
          }),
        catch: (cause) =>
          new ProviderAdapterProcessError({
            provider: PROVIDER,
            threadId,
            detail: "Failed to start Claude runtime session.",
            cause,
          }),
      });

      const session: ProviderSession = {
        threadId,
        provider: PROVIDER,
        providerInstanceId: deps.boundInstanceId,
        status: "ready",
        runtimeMode: input.runtimeMode,
        ...(input.cwd ? { cwd: input.cwd } : {}),
        ...(modelSelection?.model ? { model: modelSelection.model } : {}),
        ...(threadId ? { threadId } : {}),
        resumeCursor: {
          ...(threadId ? { threadId } : {}),
          ...(sessionId ? { resume: sessionId } : {}),
          ...(resumeState?.resumeSessionAt ? { resumeSessionAt: resumeState.resumeSessionAt } : {}),
          turnCount: resumeState?.turnCount ?? 0,
        },
        createdAt: startedAt,
        updatedAt: startedAt,
      };

      const context: ClaudeSessionContext = {
        session,
        promptQueue,
        query: queryRuntime,
        streamFiber: undefined,
        startedAt,
        basePermissionMode: permissionMode,
        currentApiModelId: apiModelId,
        currentEffort: effectiveEffort ?? undefined,
        resumeSessionId: sessionId,
        pendingApprovals,
        pendingUserInputs,
        turns: [],
        inFlightTools,
        claudeTasks,
        taskAgents,
        pendingTaskModels,
        workflowMemberFingerprints,
        liveTaskIds,
        turnState: undefined,
        lastKnownContextWindow: initialContextWindow,
        lastKnownTokenUsage: undefined,
        lastKnownTotalProcessedTokens: undefined,
        lastAssistantUuid: resumeState?.resumeSessionAt,
        lastThreadStartedId: undefined,
        announcedUsageLimits: undefined,
        stopped: false,
      };

      yield* Ref.set(contextRef, context);
      deps.sessions.set(threadId, context);

      const sessionStartedStamp = yield* deps.makeEventStamp();
      yield* deps.offerRuntimeEvent({
        type: "session.started",
        eventId: sessionStartedStamp.eventId,
        provider: PROVIDER,
        createdAt: sessionStartedStamp.createdAt,
        threadId,
        payload: input.resumeCursor !== undefined ? { resume: input.resumeCursor } : {},
        providerRefs: {},
      });

      const configuredStamp = yield* deps.makeEventStamp();
      yield* deps.offerRuntimeEvent({
        type: "session.configured",
        eventId: configuredStamp.eventId,
        provider: PROVIDER,
        createdAt: configuredStamp.createdAt,
        threadId,
        payload: {
          config: {
            ...(apiModelId ? { model: apiModelId } : {}),
            ...(input.cwd ? { cwd: input.cwd } : {}),
            ...(effectiveEffort ? { effort: effectiveEffort } : {}),
            ...(permissionMode ? { permissionMode } : {}),
            ...(fastMode ? { fastMode: true } : {}),
          },
        },
        providerRefs: {},
      });

      const readyStamp = yield* deps.makeEventStamp();
      yield* deps.offerRuntimeEvent({
        type: "session.state.changed",
        eventId: readyStamp.eventId,
        provider: PROVIDER,
        createdAt: readyStamp.createdAt,
        threadId,
        payload: {
          state: "ready",
        },
        providerRefs: {},
      });

      let streamFiber: Fiber.Fiber<void, never>;
      streamFiber = runFork(
        Effect.exit(deps.runSdkStream(context)).pipe(
          Effect.flatMap((exit) => {
            if (context.stopped) {
              return Effect.void;
            }

            if (context.streamFiber === streamFiber) {
              context.streamFiber = undefined;
            }

            return deps
              .handleStreamExit(context, exit)
              .pipe(
                Effect.catch((cause) =>
                  Effect.logError("Failed to close Claude runtime stream.", { cause }),
                ),
              );
          }),
        ),
      );
      context.streamFiber = streamFiber;
      streamFiber.addObserver(() => {
        if (context.streamFiber === streamFiber) {
          context.streamFiber = undefined;
        }
      });

      return {
        ...session,
      };
    },
  );

  return { startSession };
}
