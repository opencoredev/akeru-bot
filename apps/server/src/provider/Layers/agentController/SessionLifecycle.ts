import { createSessionContext } from "./SessionContext.ts";
import { createSessionCatalogHandlers } from "./CatalogToolHandlers.ts";
import type { SessionLifecycleDependencies } from "./SessionLifecycleDependencies.ts";
import { ProviderDriverKind } from "@akeru/contracts";

import {
  AKERU_TOOL_CATALOG,
  BALANCED_BOT_PERSONALITY_TONE,
  DEFAULT_BOT_SANDBOX_BROWSER_SHARING,
  AKERU_PRODUCT_FEEDBACK_TOOL_NAME,
  type AkeruDelegationAccessGrant,
} from "@akeru/contracts";

import * as Deferred from "effect/Deferred";

import * as Effect from "effect/Effect";

import * as Semaphore from "effect/Semaphore";

import { formatBotMemoryPrompt } from "../../../memory/BotMemory.ts";

import {
  legacyMemoryMigrationKeys,
  legacyMemoryMigrationAccesses,
  migrateLegacyBotMemory,
} from "../../../memory/LegacyMemoryMigration.ts";

import * as McpMemoryToolSession from "../../../mcp/McpMemoryToolSession.ts";

import { workerAccess } from "../../AkeruWorkerRuntime.ts";

import { formatMcpServerInstructions, sameMcpServerConfigurations } from "../../McpServerConfig.ts";
import { type AkeruToolSession } from "../../AkeruToolRuntime.ts";

import { isCodexComputerUseServer } from "../../CodexComputerUse.ts";
import { isRemoteBotSandbox } from "../../botWorkspace.ts";
import {
  botRuntimeResourceScope,
  botWorkspaceCredentialFingerprint,
  botWorkspaceIdentity,
  botWorkspaceResourceKey,
} from "../../botWorkspacePool.ts";
import { AgentControllerRuntimeError } from "../../Errors.ts";
import { type AgentControllerShape } from "../../Services/AgentController.ts";

import { type ActiveSession, type PendingApproval } from "./State.ts";

import { nowIso } from "./EventIdentity.ts";

export function createSessionLifecycle(deps: SessionLifecycleDependencies) {
  const options = deps.options;
  const { isOpenDelegation, isChildOf, readSessionStartContext } = createSessionContext(deps);

  const startSession: AgentControllerShape["startSession"] = Effect.fn(
    "AgentController.startSession",
  )(function* (threadId, input) {
    const key = String(threadId);

    const { parentDelegation, workerParent, bot, botId, activeChildDelegations, threadTitle } =
      yield* readSessionStartContext(threadId, input.botId ?? null);

    const isWorkerThread = deps.workerRuntime.depthForThread(threadId) > 0;

    const botAccess: AkeruDelegationAccessGrant = {
      allowedToolIds: AKERU_TOOL_CATALOG.map((tool) => tool.id),
      memoryScopes: ["private", "bot", "project", "group", "workspace"],
      sandbox: input.botSandbox ?? null,
      runtimeMode: input.runtimeMode,
      hasUserComputer: Boolean(input.cwd),
      enabledMcpServerIds: (input.mcpServers ?? [])
        .map((server) => server.id)
        .filter((serverId) => !bot?.disabledMcpServerIds.includes(serverId)),
      disabledMcpServerIds: bot?.disabledMcpServerIds ?? [],
      approvalCeiling: "secrets",
    };

    // A restart drops the worker runtime's grants, so a worker chat it orphaned rebuilds
    // its grant from the parent chat: the parent's delegated grant, or the bot's own for a
    // top-level parent. Without a parent link it keeps no tools rather than gaining any.
    const orphanedWorkerAccess = () =>
      workerAccess(
        workerParent
          ? (workerParent.delegatedAccess ?? {
              ...botAccess,
              sandbox: botAccess.sandbox ?? "local",
            })
          : { ...botAccess, allowedToolIds: [], enabledMcpServerIds: [] },
      );

    const delegatedAccess =
      deps.wired().delegationRuntime?.accessForThread(threadId) ??
      parentDelegation?.access ??
      deps.workerRuntime.accessForThread(threadId) ??
      (isWorkerThread ? orphanedWorkerAccess() : undefined);

    const access = delegatedAccess ?? botAccess;

    // A top-level bot's null sandbox is its local workspace, while a delegated
    // null sandbox has none, so workers receive the local workspace explicitly.
    const workerParentAccess: AkeruDelegationAccessGrant =
      delegatedAccess || access.sandbox !== null ? access : { ...access, sandbox: "local" };

    const mcpServers = (input.mcpServers ?? []).filter(
      (server) =>
        access.enabledMcpServerIds.includes(server.id) &&
        !access.disabledMcpServerIds.includes(server.id),
    );

    const workspaceType =
      delegatedAccess && access.sandbox === null
        ? "none"
        : access.sandbox === null || access.sandbox === "local"
          ? "local"
          : "cloud";

    const resourceScope = botRuntimeResourceScope({
      sharing: input.botSandboxBrowserSharing ?? DEFAULT_BOT_SANDBOX_BROWSER_SHARING,
      ...(botId ? { botId } : {}),
      threadId: key,
    });

    const workspaceResourceKey = botWorkspaceResourceKey({
      resourceScope,
      sandbox: access.sandbox,
      ...(access.sandbox !== null && access.sandbox !== "local" && input.botSandboxEnvironment
        ? {
            credentialFingerprint: botWorkspaceCredentialFingerprint(input.botSandboxEnvironment),
          }
        : {}),
    });

    const workspaceId = botWorkspaceIdentity(workspaceResourceKey);
    const existing = deps.sessions.get(key);
    const resolved = deps.resolvedByThread.get(key);

    if (!resolved) {
      return yield* new AgentControllerRuntimeError({
        operation: "startSession",
        detail: `Thread '${threadId}' has no resolved engine.`,
      });
    }

    const personalityTone =
      input.personalityTone ?? bot?.personalityTone ?? BALANCED_BOT_PERSONALITY_TONE;

    deps.resolvedByThread.set(key, {
      ...resolved,
      ...(input.botName ? { botName: input.botName } : {}),
      personalityTone,
    });

    if (deps.usesMastraCode(resolved.provider)) {
      const routing = yield* deps.legacyProviderBridge.getInstanceInfo(resolved.providerInstanceId);

      if (!routing.enabled) {
        return yield* deps.disabledProviderError(
          "AgentController.startSession",
          resolved.providerInstanceId,
        );
      }
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

    const migrationBotId = input.memoryAccess?.respondingBotId ?? input.memoryAccess?.botId;

    if (migrationBotId && input.memoryAccess && options?.entityMemoryRepository) {
      const migrationKeys = legacyMemoryMigrationKeys(input.memoryAccess);

      const migrationsComplete = yield* Effect.promise(() =>
        Promise.all(
          migrationKeys.map((migrationKey) =>
            deps.botMemoryStore.isMigrationComplete(migrationBotId, migrationKey),
          ),
        ),
      );

      if (migrationsComplete.some((complete) => !complete)) {
        const revisions = yield* Effect.forEach(
          legacyMemoryMigrationAccesses(input.memoryAccess),
          (access) => options.entityMemoryRepository!.listCurrent({ access }),
        ).pipe(
          Effect.map((sets) => [
            ...new Map(sets.flat().map((revision) => [revision.id, revision])).values(),
          ]),
          Effect.mapError(
            (cause) =>
              new AgentControllerRuntimeError({
                operation: "memory.migrate.read",
                detail: deps.failureDetail(cause),
                cause,
              }),
          ),
        );

        yield* deps.runMastra("memory.migrate", () =>
          migrateLegacyBotMemory({
            store: deps.botMemoryStore,
            access: input.memoryAccess!,
            revisions,
          }),
        );
      }
    }

    // A cwd change invalidates reuse for local workspaces: the user-computer
    // workspace lease is keyed by cwd and the session tools would keep
    // acting on the old directory. Remote sandboxes have no user-computer
    // workspace, so cwd only feeds projectPath there and can update in place.
    if (
      existing?.workspaceResourceKey === workspaceResourceKey &&
      (existing.cwd === input.cwd || isRemoteBotSandbox(access.sandbox)) &&
      existing.toolSession.workspaceType === workspaceType &&
      sameMcpServerConfigurations(existing.mcpServers, mcpServers) &&
      resolved &&
      existing.provider === resolved.provider &&
      existing.providerInstanceId === resolved.providerInstanceId
    ) {
      existing.runtimeMode = access.runtimeMode;
      existing.cwd = input.cwd;
      yield* deps.runMastra("state.set", () =>
        existing.session.state.set({
          modelOptions: deps.mastraModelOptions(resolved) ?? {},
          projectPath: input.cwd || undefined,
          yolo: false,
          botConversation: resolved.botConversation,
          botName: input.botName || "",
          personalityTone,
          mcpInstructions: formatMcpServerInstructions(mcpServers),
        }),
      );
      const toolSession = { ...existing.configuredToolSession };
      delete toolSession.botId;
      delete toolSession.botName;
      delete toolSession.billedBotId;
      delete toolSession.delegation;
      delete toolSession.workers;
      delete toolSession.memoryHandlers;
      delete toolSession.botState;
      delete toolSession.imageGeneration;
      const imageGeneration = yield* deps.imageToolSettings;
      const settings = yield* deps.memorySettings();

      const nextMemoryHandlers =
        access.memoryScopes.length > 0
          ? deps.memoryHandlers(input.memoryAccess, access.memoryScopes)
          : undefined;

      const configuredToolSession: AkeruToolSession = {
        ...toolSession,
        runtimeMode: access.runtimeMode,
        ...(botId ? { botId } : {}),
        ...(input.botName ? { botName: input.botName } : {}),
        ...(nextMemoryHandlers ? { memoryHandlers: nextMemoryHandlers } : {}),
        ...(delegatedAccess && botId ? { billedBotId: botId } : {}),
        ...(deps.wired().delegationRuntime && botId
          ? {
              delegation: deps.delegationFor({
                threadId,
                botId,
                parentDelegation,
                access,
                activeChildDelegations,
              }),
            }
          : {}),
        ...(deps.wired().workerOrchestration && botId && !isWorkerThread
          ? { workers: deps.workersFor(threadId, workerParentAccess) }
          : {}),
        ...(input.botId && deps.wired().botStateRuntime
          ? { botState: deps.wired().botStateRuntime }
          : {}),
        imageGeneration,
      };

      existing.configuredToolSession = configuredToolSession;
      existing.startInput = input;
      existing.configuredMemoryAccess = delegatedAccess
        ? undefined
        : deps.memoryAccessFor(input.memoryAccess);
      existing.configuredEntityMemoryAccess = input.memoryAccess;
      existing.privateBotMemory = settings.privateBotMemory;

      if (!existing.activeTurn && !existing.admittingTurn && existing.pendingTurns.length === 0) {
        existing.toolSession = configuredToolSession;
        existing.memoryAccess = existing.configuredMemoryAccess;
        existing.entityMemoryAccess = existing.configuredEntityMemoryAccess;
        deps.toolRuntime.registerSession(key, existing.toolSession);
      }

      return deps.toProviderSession(threadId, existing);
    }

    const existingLegacy = deps.legacyResourceIdentity.get(key);
    const settings = yield* deps.memorySettings();
    const nextMemoryAccess = delegatedAccess ? undefined : deps.memoryAccessFor(input.memoryAccess);

    const nextMemoryHandlers =
      access.memoryScopes.length > 0
        ? deps.memoryHandlers(input.memoryAccess, access.memoryScopes)
        : undefined;

    if (
      !existing &&
      resolved &&
      existingLegacy?.workspaceResourceKey === workspaceResourceKey &&
      existingLegacy.cwd === input.cwd &&
      existingLegacy.provider === resolved.provider &&
      existingLegacy.providerInstanceId === resolved.providerInstanceId &&
      existingLegacy.botName === input.botName &&
      existingLegacy.personalityTone === personalityTone &&
      existingLegacy.memoryAccessKey === deps.memoryAccessKey(nextMemoryAccess)
    ) {
      const live = (yield* deps.legacyProviderBridge.listSessions()).find(
        (session) => session.threadId === threadId,
      );

      if (live) {
        existingLegacy.memoryAccess = nextMemoryAccess;
        existingLegacy.entityMemoryAccess = input.memoryAccess;
        existingLegacy.privateBotMemory = settings.privateBotMemory;

        if (nextMemoryHandlers?.memory) {
          McpMemoryToolSession.setMcpMemoryToolSession(threadId, nextMemoryHandlers.memory);
        } else {
          McpMemoryToolSession.clearMcpMemoryToolSession(threadId);
        }

        return live;
      }

      yield* deps
        .runMastra("resources.release", () => deps.sessionResources.release(key))
        .pipe(Effect.ignoreCause({ log: true }));
      deps.legacyResourceIdentity.delete(key);
    }

    if (existing || existingLegacy) {
      const previousWorkspaceResourceKey =
        existing?.workspaceResourceKey ?? existingLegacy?.workspaceResourceKey;

      yield* deps.stopSessionWithResources(
        { threadId },
        previousWorkspaceResourceKey !== undefined &&
          botWorkspaceIdentity(previousWorkspaceResourceKey) !== workspaceId,
      );
    }

    if (delegatedAccess && !deps.usesMastraCode(resolved.provider)) {
      return yield* new AgentControllerRuntimeError({
        operation: "startSession",
        detail: `Provider '${resolved.provider}' cannot enforce delegated access.`,
      });
    }

    if (!(delegatedAccess && access.sandbox === null)) {
      yield* deps.preparePreviewMcpSession(
        threadId,
        resolved.providerInstanceId,
        deps.usesMastraCode(resolved.provider) ? undefined : nextMemoryHandlers?.memory,
      );
    }

    const resources =
      delegatedAccess && access.sandbox === null
        ? ({ workspaceType: "none" } as const)
        : yield* deps
            .runMastra("resources.acquire", () =>
              deps.sessionResources.acquire({
                threadId: key,
                resourceScope,
                workspaceResourceKey,
                workspaceId,
                ...(access.sandbox !== null ? { botSandbox: access.sandbox } : {}),
                ...(access.sandbox !== null &&
                access.sandbox !== "local" &&
                input.botSandboxEnvironment
                  ? { sandboxEnvironment: input.botSandboxEnvironment }
                  : {}),
                ...((!delegatedAccess || access.hasUserComputer) && input.cwd
                  ? { userComputerCwd: input.cwd }
                  : {}),
                mcpServers,
                exclusiveComputer: resolved.provider === "codex" || resolved.provider === "kimi",
                ...(botId ? { botId } : {}),
                ...(bot?.name ? { botName: bot.name } : {}),
                taskOrRoutine: threadTitle ?? "Browser task",
              }),
            )
            .pipe(Effect.onError(() => deps.clearPreviewMcpSession(threadId)));

    if (!deps.usesMastraCode(resolved.provider)) {
      const frozenMemoryContext =
        nextMemoryAccess && settings.enabled
          ? formatBotMemoryPrompt(
              yield* Effect.promise(() =>
                settings.privateBotMemory
                  ? deps.botMemoryStore.readPromptSnapshot(nextMemoryAccess)
                  : deps.botMemoryStore.readPromptSnapshot(nextMemoryAccess).then((snapshot) => ({
                      ...snapshot,
                      memory: { ...snapshot.memory, content: "", charCount: 0 },
                    })),
              ),
            )
          : "";

      const entityPacket =
        nextMemoryAccess && settings.enabled
          ? yield* deps.runMastra("memory.packet", () =>
              deps.entityMemoryContext(input.memoryAccess),
            )
          : "";

      const combinedMemoryContext = [frozenMemoryContext, entityPacket]
        .filter(Boolean)
        .join("\n\n");

      return yield* deps.legacyProviderBridge
        .startSession(threadId, {
          ...input,
          personalityTone,
          ...(combinedMemoryContext ? { persistentMemoryContext: combinedMemoryContext } : {}),
        })
        .pipe(
          Effect.tap((session) =>
            Effect.sync(() => {
              deps.legacyResourceIdentity.set(key, {
                workspaceResourceKey,
                cwd: input.cwd,
                provider: resolved.provider,
                providerInstanceId: resolved.providerInstanceId,
                botName: input.botName,
                personalityTone,
                memoryAccess: nextMemoryAccess,
                entityMemoryAccess: input.memoryAccess,
                memoryAccessKey: deps.memoryAccessKey(nextMemoryAccess),
                privateBotMemory: settings.privateBotMemory,
              });

              return session;
            }),
          ),
          Effect.tapError(() =>
            deps
              .runMastra("resources.release", () =>
                deps.sessionResources.release(key, { destroy: true }),
              )
              .pipe(Effect.ignoreCause({ log: true })),
          ),
        );
    }

    const workspace = "botWorkspace" in resources ? resources.botWorkspace : undefined;

    const userComputerWorkspace =
      "workspace" in resources && access.hasUserComputer && workspaceType === "local" && input.cwd
        ? resources.workspace
        : undefined;

    const registeredMemoryHandlers = nextMemoryHandlers;
    const mcpManager = deps.sessionResources.getMcpManager(key);
    const imageGenerationSettings = yield* deps.imageToolSettings;

    const toolSession: AkeruToolSession = {
      ...(botId ? { botId } : {}),
      ...(input.botName ? { botName: input.botName } : {}),
      runtimeMode: access.runtimeMode,
      workspaceType,
      ...(workspace ? { workspace } : {}),
      ...(userComputerWorkspace ? { userComputerWorkspace } : {}),
      ...(registeredMemoryHandlers ? { memoryHandlers: registeredMemoryHandlers } : {}),
      ...(input.botId && deps.wired().botStateRuntime
        ? { botState: deps.wired().botStateRuntime }
        : {}),
      imageGeneration: imageGenerationSettings,
      catalogHandlers: createSessionCatalogHandlers(deps, {
        threadId,
        botId: input.botId,
        botName: input.botName,
        mcpManager,
      }),
      ...(delegatedAccess && botId ? { billedBotId: botId } : {}),
      ...(deps.wired().delegationRuntime && botId
        ? {
            sendToUser: async (request) => {
              const active = deps.sessions.get(key);
              const turnId = active?.activeTurn?.turnId;

              if (!turnId) throw new Error("User messaging requires an active turn.");

              return deps.wired().delegationRuntime!.sendToUser(
                {
                  threadId,
                  turnId,
                  botId,
                  parentDelegationId: parentDelegation?.delegationId ?? null,
                  ancestorBotIds: parentDelegation?.ancestorBotIds ?? [],
                  depth: parentDelegation?.depth ?? 0,
                  access,
                },
                request,
              );
            },
            delegation: deps.delegationFor({
              threadId,
              botId,
              parentDelegation,
              access,
              activeChildDelegations,
            }),
          }
        : {}),
      ...(deps.wired().workerOrchestration && botId && !isWorkerThread
        ? { workers: deps.workersFor(threadId, workerParentAccess) }
        : {}),
      ...(input.botId && deps.wired().channelRuntime
        ? {
            reactToMessage: (request, toolCallId) =>
              deps.wired().channelRuntime!.react(threadId, input.botId!, request, toolCallId),
            channels: {
              create: (request) => deps.wired().channelRuntime!.create(input.botId!, request),
              update: (request) => deps.wired().channelRuntime!.update(input.botId!, request),
            },
          }
        : {}),
    };

    deps.toolRuntime.registerSession(key, toolSession);

    const session = yield* deps
      .runMastra("createSession", () =>
        deps.bundle.controller.createSession({
          id: key,
          ownerId: "akeru-desktop",
          resourceId: key,
          threadId: key,
          ...(input.cwd ? { tags: { projectPath: input.cwd } } : {}),
          ...(workspace ? { workspace } : {}),
        }),
      )
      .pipe(
        Effect.tapError(() =>
          Effect.all(
            [
              deps
                .runMastra("resources.release", () =>
                  deps.sessionResources.release(key, { destroy: true }),
                )
                .pipe(Effect.ignoreCause({ log: true })),
              Effect.sync(() => deps.toolRuntime.unregisterSession(key)),
            ],
            { discard: true },
          ),
        ),
      );

    const cleanupCreatedSession = Effect.gen(function* () {
      yield* deps
        .runMastra("deleteSession", () => deps.bundle.controller.deleteSession({ resourceId: key }))
        .pipe(Effect.ignoreCause({ log: true }));
      yield* deps
        .runMastra("resources.release", () => deps.sessionResources.release(key, { destroy: true }))
        .pipe(Effect.ignoreCause({ log: true }));
      deps.toolRuntime.unregisterSession(key);
    });

    const active = yield* Effect.gen(function* () {
      const modelOptions = deps.mastraModelOptions(resolved);
      yield* deps.runMastra("state.set", () =>
        session.state.set({
          providerInstanceId: String(resolved.providerInstanceId),
          ...(input.cwd ? { projectPath: input.cwd } : {}),
          yolo: false,
          botConversation: resolved.botConversation,
          ...(input.botName ? { botName: input.botName } : {}),
          personalityTone,
          mcpInstructions: formatMcpServerInstructions(mcpServers),
          modelOptions: modelOptions ?? {},
        }),
      );
      yield* deps.runMastra("model.switch", () =>
        session.model.switch({ modelId: resolved.mastraModelId }),
      );

      if (session.mode.get() !== deps.DEFAULT_MODE_ID) {
        yield* deps.runMastra("mode.switch", () =>
          session.mode.switch({ modeId: deps.DEFAULT_MODE_ID }),
        );
      }

      yield* Effect.forEach(
        ["read", "edit", "execute", "mcp", "other"] as const,
        (category) =>
          deps.runMastra("permissions.setForCategory", () =>
            session.permissions.setForCategory({
              category,
              policy: deps.permissionPolicy(access.runtimeMode, category),
            }),
          ),
        { discard: true },
      );
      yield* Effect.forEach(
        new Set([
          ...deps.toolRuntime.toolsForThread(key).map((tool) => tool.id),
          ...Object.keys(deps.sessionResources.getConnectorTools(key)),
          AKERU_PRODUCT_FEEDBACK_TOOL_NAME,
          "RestartMcpServers",
        ]),
        (toolName) =>
          deps.runMastra("permissions.setForTool", () =>
            session.permissions.setForTool({ toolName, policy: "ask" }),
          ),
        { discard: true },
      );

      const unsubscribe = session.subscribe((event) => {
        const current = deps.sessions.get(key);

        if (current) deps.handleControllerEvent(threadId, current, event);
      });

      const turnPreparation = yield* Semaphore.make(1);

      return {
        session,
        turnPreparation,
        startInput: input,
        pendingDispatches: new Set<Promise<void>>(),
        provider: resolved.provider,
        providerInstanceId: resolved.providerInstanceId,
        cwd: input.cwd,
        createdAt: nowIso(),
        mcpServerIds: mcpServers.map((server) => server.id),
        mcpServers,
        runtimeMode: access.runtimeMode,
        model: resolved.modelSelection.model,
        status: "ready" as const,
        turnAdmissionGeneration: 0,
        turnPreparationCancelled: Deferred.makeUnsafe<void>(),
        activeTurn: null,
        admittingTurn: null,
        pendingTurns: [],
        toolNames: new Map<string, string>(),
        approvalRequests: new Map(),
        connectorSessionApprovals: new Set<string>(),
        toolSession,
        memoryAccess: nextMemoryAccess,
        entityMemoryAccess: input.memoryAccess,
        configuredToolSession: toolSession,
        configuredMemoryAccess: nextMemoryAccess,
        configuredEntityMemoryAccess: input.memoryAccess,
        privateBotMemory: settings.privateBotMemory,
        workspaceResourceKey,
        pendingApprovals: new Map<string, PendingApproval>(),
        unsubscribe,
      } satisfies ActiveSession;
    }).pipe(Effect.onError(() => cleanupCreatedSession));

    deps.sessions.set(key, active);
    deps.publish({
      ...deps.baseEvent(threadId, active),
      type: "session.started",
      payload: { message: "Mastra Code session ready" },
    });
    deps.publishSessionState(threadId, active, "ready");

    return deps.toProviderSession(threadId, active);
  });

  return { isOpenDelegation, isChildOf, readSessionStartContext, startSession };
}
