import {
  AkeruMemoryTenantId,
  AkeruMemoryUserId,
  type ChatAttachment,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  type ModelSelection,
  isGroupBotMember,
  ProviderDriverKind,
  type ProjectId,
  ThreadId,
  type ProviderSession,
  SANDBOX_PROVIDER_CREDENTIALS,
} from "@akeru/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as Option from "effect/Option";
import { resolveThreadWorkspaceCwd } from "../../../checkpointing/Utils.ts";
import { ProviderAdapterRequestError } from "../../../provider/Errors.ts";
import {
  botRuntimeResourceScope,
  botWorkspaceCredentialFingerprint,
  botWorkspaceResourceKey,
} from "../../../provider/botWorkspacePool.ts";
import {
  providerErrorLabel,
  isProviderDriverKind,
  resolveControllerBotId,
  mapProviderSessionStatusToOrchestrationStatus,
  toNonEmptyProviderInput,
} from "./Fields.ts";
import type { createContext } from "./Context.ts";
import type { createDependencies } from "./Dependencies.ts";
import type { createFailures } from "./Failures.ts";
import type { createWorkspace } from "./Workspace.ts";
import type { createMentions } from "./Mentions.ts";

export function createSession({
  resolveThreadShell,
  threadsAwaitingRestrictiveSessionCleanup,
  agentController,
  resolveControllerEngine,
  inspectAvailableEngine,
  setThreadSession,
  rejectStartedThreadModelChangeIfRequired,
  resolveProject,
  projectionSnapshotQuery,
  resolveControllerMcpServers,
  serverSettingsService,
  projectionBotRepository,
  threadModelSelections,
  threadMcpServers,
  threadBotWorkspaceKeys,
  providerSessionDirectory,
  expandComposerMentions,
}: Pick<
  ReturnType<typeof createContext> &
    Effect.Success<ReturnType<typeof createDependencies>> &
    ReturnType<typeof createFailures> &
    ReturnType<typeof createWorkspace> &
    ReturnType<typeof createMentions>,
  | "resolveThreadShell"
  | "threadsAwaitingRestrictiveSessionCleanup"
  | "agentController"
  | "resolveControllerEngine"
  | "inspectAvailableEngine"
  | "setThreadSession"
  | "rejectStartedThreadModelChangeIfRequired"
  | "resolveProject"
  | "projectionSnapshotQuery"
  | "resolveControllerMcpServers"
  | "serverSettingsService"
  | "projectionBotRepository"
  | "threadModelSelections"
  | "threadMcpServers"
  | "threadBotWorkspaceKeys"
  | "providerSessionDirectory"
  | "expandComposerMentions"
>) {
  const reconcileRestrictiveSessionCleanup = Effect.fn("reconcileRestrictiveSessionCleanup")(
    function* (threadId: ThreadId) {
      const thread = yield* resolveThreadShell(threadId);

      const persistedCleanupRequired =
        thread?.runtimeMode === "approval-required" &&
        thread.session?.runtimeMode === "full-access" &&
        thread.session.status === "error";

      if (!threadsAwaitingRestrictiveSessionCleanup.has(threadId) && !persistedCleanupRequired) {
        return false;
      }

      threadsAwaitingRestrictiveSessionCleanup.add(threadId);

      const activeSession = (yield* agentController.listSessions()).find(
        (session) => session.threadId === threadId,
      );

      if (activeSession === undefined) {
        threadsAwaitingRestrictiveSessionCleanup.delete(threadId);

        return true;
      }

      yield* agentController.interruptTurn({ threadId }).pipe(
        Effect.catchCause((cause) => {
          if (Cause.hasInterruptsOnly(cause)) {
            return Effect.interrupt;
          }

          return Effect.logWarning(
            "provider command reactor failed to interrupt quarantined session",
            {
              threadId,
              cause: Cause.pretty(cause),
            },
          );
        }),
      );

      const sessionAfterInterrupt = (yield* agentController.listSessions()).find(
        (session) => session.threadId === threadId,
      );

      if (sessionAfterInterrupt === undefined) {
        threadsAwaitingRestrictiveSessionCleanup.delete(threadId);

        return true;
      }

      yield* agentController.stopSession({ threadId });

      const remainingSession = (yield* agentController.listSessions()).find(
        (session) => session.threadId === threadId,
      );

      if (remainingSession !== undefined) {
        return yield* new ProviderAdapterRequestError({
          provider: providerErrorLabel(remainingSession.provider),
          method: "thread.session.stop",
          detail: `Provider session '${threadId}' is still active after a restrictive runtime mode update failed.`,
        });
      }

      threadsAwaitingRestrictiveSessionCleanup.delete(threadId);

      return true;
    },
  );

  const ensureSessionForThread = Effect.fn("ensureSessionForThread")(function* (
    threadId: ThreadId,
    createdAt: string,
    options?: {
      readonly modelSelection?: ModelSelection;
      readonly pendingTurnStart?: boolean;
    },
  ) {
    const thread = yield* resolveThreadShell(threadId);

    if (!thread) {
      return yield* Effect.die(new Error(`Thread '${threadId}' was not found in read model.`));
    }

    const desiredRuntimeMode = thread.runtimeMode;
    const requestedModelSelection = options?.modelSelection;

    const resolveActiveSession = (threadId: ThreadId) =>
      agentController
        .listSessions()
        .pipe(Effect.map((sessions) => sessions.find((session) => session.threadId === threadId)));

    const activeSession = yield* resolveActiveSession(threadId);

    const activeThreadSession =
      thread.session !== null && thread.session.status !== "stopped" && activeSession
        ? thread.session
        : null;

    if (
      activeThreadSession !== null &&
      activeSession !== undefined &&
      (activeThreadSession.providerInstanceId === undefined ||
        activeSession.providerInstanceId === undefined)
    ) {
      return yield* new ProviderAdapterRequestError({
        provider: providerErrorLabel(activeThreadSession.providerName ?? undefined),
        method: "thread.turn.start",
        detail: `Thread '${threadId}' has an active provider session without a provider instance id.`,
      });
    }

    const currentInstanceId =
      activeThreadSession !== null &&
      activeSession !== undefined &&
      activeSession.providerInstanceId !== undefined
        ? activeSession.providerInstanceId
        : thread.modelSelection.instanceId;

    const desiredEngine = yield* resolveControllerEngine(
      thread,
      requestedModelSelection ?? thread.modelSelection,
    );

    const desiredModelSelection = desiredEngine.modelSelection;
    const desiredInstanceId = desiredModelSelection.instanceId;

    const effectiveRequestedModelSelection = desiredEngine.configured
      ? desiredModelSelection
      : requestedModelSelection;

    const currentEngine =
      currentInstanceId === desiredInstanceId
        ? desiredEngine
        : yield* inspectAvailableEngine({
            instanceId: currentInstanceId,
            model: activeSession?.model ?? thread.modelSelection.model,
          });

    const currentInfo = currentEngine.routing;
    const desiredInfo = desiredEngine.routing;
    const desiredDriverKind = desiredInfo.driverKind;

    if (!isProviderDriverKind(desiredDriverKind)) {
      return yield* new ProviderAdapterRequestError({
        provider: providerErrorLabel(String(desiredDriverKind)),
        method: "thread.turn.start",
        detail: `Requested provider instance '${desiredInstanceId}' uses unknown provider driver '${desiredDriverKind}'. The driver is not installed in this build.`,
      });
    }

    const preferredProvider: ProviderDriverKind = desiredDriverKind;

    if (options?.pendingTurnStart === true && thread.session?.status !== "running") {
      yield* setThreadSession({
        threadId,
        session: {
          threadId,
          status: "starting",
          providerName: activeSession?.provider ?? preferredProvider,
          providerInstanceId: activeSession?.providerInstanceId ?? desiredInstanceId,
          runtimeMode: desiredRuntimeMode,
          mcpServerIds: activeSession?.mcpServerIds ?? [],
          activeTurnId: null,
          lastError: null,
          updatedAt: createdAt,
        },
        createdAt,
      });
    }

    if (thread.session !== null) {
      yield* rejectStartedThreadModelChangeIfRequired({
        threadId,
        currentModelSelection:
          activeSession?.model !== undefined
            ? {
                ...thread.modelSelection,
                instanceId: currentInstanceId,
                model: activeSession.model,
              }
            : thread.modelSelection,
        requestedModelSelection: effectiveRequestedModelSelection,
      });
    }

    const providerChanged = currentInfo.driverKind !== desiredInfo.driverKind;
    const project = yield* resolveProject(thread.projectId);

    const legacyWorkspaceOwnerProjectId = project
      ? yield* projectionSnapshotQuery.getOriginalProjectIdByWorkspaceRoot(project.workspaceRoot)
      : Option.none<ProjectId>();

    const mcpServers = yield* resolveControllerMcpServers(thread);
    const serverSettings = yield* serverSettingsService.getSettings;
    const botSandboxBrowserSharing = serverSettings.botSandboxBrowserSharing;
    const respondingBotId = resolveControllerBotId(thread);

    const respondingBot =
      respondingBotId === null
        ? undefined
        : yield* projectionBotRepository
            .getById({ botId: respondingBotId })
            .pipe(Effect.map(Option.getOrUndefined));

    const respondingGroup =
      thread.groupId == null
        ? undefined
        : projectionSnapshotQuery.getGroupById
          ? Option.getOrUndefined(yield* projectionSnapshotQuery.getGroupById(thread.groupId))
          : (yield* projectionSnapshotQuery.getCommandReadModel()).groups.find(
              (group) => group.id === thread.groupId,
            );

    const effectiveSandbox = respondingBot?.sandbox ?? serverSettings.sandbox.defaultProvider;

    const sandboxEnvironment =
      effectiveSandbox === "local"
        ? undefined
        : Object.fromEntries(
            serverSettings.sandbox.providers[effectiveSandbox].environment.map((variable) => [
              variable.name,
              variable.value,
            ]),
          );

    if (effectiveSandbox !== "local") {
      const missingCredential = SANDBOX_PROVIDER_CREDENTIALS[effectiveSandbox].find(
        (credential) => !(sandboxEnvironment?.[credential.name] ?? "").trim(),
      );

      if (missingCredential) {
        return yield* new ProviderAdapterRequestError({
          provider: providerErrorLabel(preferredProvider),
          method: "thread.turn.start",
          detail: `Connect ${effectiveSandbox} in Settings before using it as a bot sandbox.`,
        });
      }
    }

    const effectiveCwd = resolveThreadWorkspaceCwd({
      thread,
      projects: project ? [project] : [],
    });

    const botWorkspaceKey = botWorkspaceResourceKey({
      resourceScope: botRuntimeResourceScope({
        sharing: botSandboxBrowserSharing,
        ...(respondingBotId ? { botId: respondingBotId } : {}),
        threadId,
      }),
      sandbox: effectiveSandbox,
      ...(sandboxEnvironment
        ? {
            credentialFingerprint: botWorkspaceCredentialFingerprint(sandboxEnvironment),
          }
        : {}),
    });

    const startProviderSession = (input?: {
      readonly resumeCursor?: unknown;
      readonly provider?: ProviderDriverKind;
    }) =>
      agentController.startSession(threadId, {
        threadId,
        ...(preferredProvider ? { provider: preferredProvider } : {}),
        providerInstanceId: desiredInstanceId,
        ...(effectiveCwd ? { cwd: effectiveCwd } : {}),
        ...(thread.title ? { title: thread.title } : {}),
        modelSelection: desiredModelSelection,
        mcpServers,
        ...(respondingBotId ? { botId: respondingBotId } : {}),
        ...(respondingBot ? { botName: respondingBot.name } : {}),
        ...(respondingBot?.personalityTone !== undefined
          ? { personalityTone: respondingBot.personalityTone }
          : {}),
        ...(project
          ? {
              memoryAccess: {
                tenantId: AkeruMemoryTenantId.make("local"),
                userId: AkeruMemoryUserId.make("owner"),
                threadId,
                projectId: thread.projectId,
                workspaceRoot: project.workspaceRoot,
                ...(Option.isSome(legacyWorkspaceOwnerProjectId)
                  ? { legacyWorkspaceOwnerProjectId: legacyWorkspaceOwnerProjectId.value }
                  : {}),
                botId: thread.groupId == null ? respondingBotId : null,
                groupId: thread.groupId ?? null,
                respondingBotId,
                groupMemberBotIds:
                  respondingGroup?.members.filter(isGroupBotMember).map((member) => member.botId) ??
                  [],
              },
            }
          : {}),
        botSandbox: effectiveSandbox,
        ...(sandboxEnvironment ? { botSandboxEnvironment: sandboxEnvironment } : {}),
        botSandboxBrowserSharing,
        ...(input?.resumeCursor !== undefined ? { resumeCursor: input.resumeCursor } : {}),
        runtimeMode: desiredRuntimeMode,
      });

    const bindSessionToThread = (session: ProviderSession) =>
      Effect.gen(function* () {
        if (session.providerInstanceId === undefined) {
          return yield* new ProviderAdapterRequestError({
            provider: providerErrorLabel(session.provider),
            method: "thread.turn.start",
            detail: `Provider session '${session.threadId}' started without a provider instance id.`,
          });
        }

        yield* setThreadSession({
          threadId,
          session: {
            threadId,
            status:
              options?.pendingTurnStart === true && session.status === "ready"
                ? "starting"
                : mapProviderSessionStatusToOrchestrationStatus(session.status),
            providerName: session.provider,
            providerInstanceId: session.providerInstanceId,
            runtimeMode: desiredRuntimeMode,
            mcpServerIds: session.mcpServerIds ?? [],
            // Provider turn ids are not orchestration turn ids.
            activeTurnId: null,
            lastError: session.lastError ?? null,
            updatedAt: session.updatedAt,
          },
          createdAt,
        });
      });

    const existingSessionThreadId =
      thread.session && thread.session.status !== "stopped" && activeSession ? thread.id : null;

    if (existingSessionThreadId) {
      const runtimeModeChanged = thread.runtimeMode !== thread.session?.runtimeMode;
      const cwdChanged = effectiveCwd !== activeSession?.cwd;
      const sessionModelSwitch = desiredEngine.capabilities.sessionModelSwitch;

      const modelChanged =
        effectiveRequestedModelSelection !== undefined &&
        effectiveRequestedModelSelection.model !== activeSession?.model;

      const instanceChanged =
        effectiveRequestedModelSelection !== undefined &&
        activeSession?.providerInstanceId !== effectiveRequestedModelSelection.instanceId;

      const shouldRestartForModelChange = modelChanged && sessionModelSwitch === "unsupported";
      const previousModelSelection = threadModelSelections.get(threadId);

      const shouldRestartForModelSelectionChange =
        preferredProvider === "claudeAgent" &&
        effectiveRequestedModelSelection !== undefined &&
        !Equal.equals(previousModelSelection, effectiveRequestedModelSelection);

      const previousMcpServers = threadMcpServers.get(threadId);

      const mcpServersChanged = previousMcpServers
        ? !Equal.equals(previousMcpServers, mcpServers)
        : !Equal.equals(
            activeSession?.mcpServerIds ?? [],
            mcpServers.map((server) => server.id),
          );

      const previousBotWorkspaceKey = threadBotWorkspaceKeys.get(threadId);

      const botWorkspaceChanged =
        previousBotWorkspaceKey !== undefined && previousBotWorkspaceKey !== botWorkspaceKey;

      const activeTurnId = activeSession?.activeTurnId;

      if (botWorkspaceChanged && activeTurnId !== undefined) {
        yield* Effect.logInfo("provider command reactor deferred bot workspace migration", {
          threadId,
          activeTurnId,
          previousBotWorkspaceKey,
          botWorkspaceKey,
        });

        return { threadId: existingSessionThreadId, engine: desiredEngine };
      }

      if (
        !runtimeModeChanged &&
        !cwdChanged &&
        !instanceChanged &&
        !shouldRestartForModelChange &&
        !shouldRestartForModelSelectionChange &&
        !mcpServersChanged &&
        !botWorkspaceChanged
      ) {
        threadBotWorkspaceKeys.set(threadId, botWorkspaceKey);
        threadMcpServers.set(threadId, mcpServers);

        return { threadId: existingSessionThreadId, engine: desiredEngine };
      }

      const resumeCursor =
        shouldRestartForModelChange || providerChanged || botWorkspaceChanged
          ? undefined
          : (activeSession?.resumeCursor ?? undefined);

      yield* Effect.logInfo("provider command reactor restarting provider session", {
        threadId,
        existingSessionThreadId,
        currentProvider: activeSession?.provider,
        currentInstanceId,
        desiredInstanceId,
        desiredProvider: desiredModelSelection.instanceId,
        currentRuntimeMode: thread.session?.runtimeMode,
        desiredRuntimeMode: thread.runtimeMode,
        runtimeModeChanged,
        previousCwd: activeSession?.cwd,
        desiredCwd: effectiveCwd,
        cwdChanged,
        modelChanged,
        instanceChanged,
        providerChanged,
        shouldRestartForModelChange,
        shouldRestartForModelSelectionChange,
        mcpServersChanged,
        botWorkspaceChanged,
        hasResumeCursor: resumeCursor !== undefined,
      });

      if (mcpServersChanged || providerChanged) {
        yield* agentController.stopSession({ threadId });
      }

      const restartedSession = yield* startProviderSession(
        resumeCursor !== undefined ? { resumeCursor } : undefined,
      );

      yield* Effect.logInfo("provider command reactor restarted provider session", {
        threadId,
        previousSessionId: existingSessionThreadId,
        restartedSessionThreadId: restartedSession.threadId,
        provider: restartedSession.provider,
        runtimeMode: restartedSession.runtimeMode,
        cwd: restartedSession.cwd,
      });
      yield* bindSessionToThread(restartedSession);
      threadBotWorkspaceKeys.set(threadId, botWorkspaceKey);
      threadMcpServers.set(threadId, mcpServers);

      return { threadId: restartedSession.threadId, engine: desiredEngine };
    }

    const persistedBinding = Option.isSome(providerSessionDirectory)
      ? yield* providerSessionDirectory.value.getBinding(threadId).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("provider command reactor could not read resumable session binding", {
              threadId,
              cause: Cause.pretty(cause),
            }).pipe(Effect.as(Option.none())),
          ),
        )
      : Option.none();

    const resumableBinding = Option.getOrUndefined(persistedBinding);

    const resumeCursor =
      resumableBinding?.provider === preferredProvider &&
      resumableBinding.providerInstanceId === desiredInstanceId &&
      resumableBinding.resumeCursor != null
        ? resumableBinding.resumeCursor
        : undefined;

    const startedSession = yield* startProviderSession(
      resumeCursor === undefined ? undefined : { resumeCursor },
    );

    yield* bindSessionToThread(startedSession);
    threadBotWorkspaceKeys.set(threadId, botWorkspaceKey);
    threadMcpServers.set(threadId, mcpServers);

    return { threadId: startedSession.threadId, engine: desiredEngine };
  });

  const buildSendTurnRequestForThread = Effect.fnUntraced(function* (input: {
    readonly threadId: ThreadId;
    readonly messageText: string;
    readonly attachments?: ReadonlyArray<ChatAttachment>;
    readonly modelSelection?: ModelSelection;
    readonly hiddenWake?: boolean;
    readonly timezone?: string;
    readonly createdAt: string;
  }) {
    const thread = yield* resolveThreadShell(input.threadId);

    if (!thread) {
      return yield* Effect.die(
        new Error(`Thread '${input.threadId}' was not found in read model.`),
      );
    }

    const ensured = yield* ensureSessionForThread(input.threadId, input.createdAt, {
      ...(input.modelSelection !== undefined ? { modelSelection: input.modelSelection } : {}),
      pendingTurnStart: true,
    });

    if (input.modelSelection !== undefined || ensured.engine.configured) {
      threadModelSelections.set(input.threadId, ensured.engine.modelSelection);
    }

    const normalizedInput = toNonEmptyProviderInput(
      yield* expandComposerMentions(input.threadId, input.messageText),
    );

    const normalizedAttachments = input.attachments ?? [];

    const activeSession = yield* agentController
      .listSessions()
      .pipe(
        Effect.map((sessions) => sessions.find((session) => session.threadId === input.threadId)),
      );

    const sessionModelSwitch =
      activeSession === undefined
        ? "in-session"
        : activeSession.providerInstanceId === undefined
          ? yield* new ProviderAdapterRequestError({
              provider: providerErrorLabel(activeSession.provider),
              method: "thread.turn.start",
              detail: `Active provider session '${activeSession.threadId}' is missing a provider instance id.`,
            })
          : activeSession.providerInstanceId === ensured.engine.modelSelection.instanceId
            ? ensured.engine.capabilities.sessionModelSwitch
            : (yield* inspectAvailableEngine({
                instanceId: activeSession.providerInstanceId,
                model: activeSession.model ?? thread.modelSelection.model,
              })).capabilities.sessionModelSwitch;

    const requestedModelSelection = ensured.engine.modelSelection;

    const modelForTurn =
      sessionModelSwitch === "unsupported" && input.modelSelection === undefined
        ? activeSession?.model !== undefined
          ? {
              ...requestedModelSelection,
              model: activeSession.model,
            }
          : requestedModelSelection
        : ensured.engine.configured
          ? requestedModelSelection
          : input.modelSelection;

    return {
      threadId: input.threadId,
      ...(normalizedInput ? { input: normalizedInput } : {}),
      ...(normalizedAttachments.length > 0 ? { attachments: normalizedAttachments } : {}),
      ...(modelForTurn !== undefined ? { modelSelection: modelForTurn } : {}),
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      ...(input.hiddenWake !== undefined ? { hiddenWake: input.hiddenWake } : {}),
      ...(input.timezone !== undefined ? { timezone: input.timezone } : {}),
    };
  });

  return {
    reconcileRestrictiveSessionCleanup,
    ensureSessionForThread,
    buildSendTurnRequestForThread,
  };
}
