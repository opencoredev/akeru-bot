import * as Predicate from "effect/Predicate";
/**
 * ClaudeAdapterLive - Scoped live implementation for the Claude Agent provider adapter.
 *
 * Wraps `@anthropic-ai/claude-agent-sdk` query sessions behind the generic
 * provider adapter contract and emits canonical runtime events.
 *
 * @module ClaudeAdapterLive
 */
import {
  type Options as ClaudeQueryOptions,
  type PermissionMode,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { parseCliArgs } from "@akeru/shared/cliArgs";
import {
  ApprovalRequestId,
  type ClaudeSettings,
  EventId,
  ProviderInstanceId,
  type ProviderRuntimeEvent,
  type ProviderSession,
  ThreadId,
} from "@akeru/contracts";
import {
  getModelSelectionBooleanOptionValue,
  getModelSelectionStringOptionValue,
  getProviderOptionDescriptors,
} from "@akeru/shared/model";
import * as Cause from "effect/Cause";

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
  getEffectiveClaudeAgentEffort,
  readClaudeResumeState,
} from "./ClaudeProtocolValues.ts";

import { selectedClaudeContextWindow } from "./ClaudeUsage.ts";
import { CLAUDE_SETTING_SOURCES } from "./ClaudePrompt.ts";
import { createClaudeSessionPermissions } from "./ClaudeSessionPermissions.ts";

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

      const { canUseTool, onUserDialog } = createClaudeSessionPermissions({
        runtimeMode: input.runtimeMode,
        contextRef,
        pendingApprovals,
        pendingUserInputs,
        runFork,
        runPromise,
        randomUUIDv4: deps.randomUUIDv4,
        makeEventStamp: deps.makeEventStamp,
        offerRuntimeEvent: deps.offerRuntimeEvent,
        emitProposedPlanCompleted: deps.emitProposedPlanCompleted,
      });

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
