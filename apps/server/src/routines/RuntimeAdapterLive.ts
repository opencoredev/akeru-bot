import { CommandId, MessageId, type OrchestrationCommand } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { BotInboxService, type BotInboxItem } from "../bot-inbox/service.ts";
import { ServerConfig } from "../config.ts";
import { isSubscriptionProviderId, SubscriptionAuthService } from "../subscription-auth/service.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProjectionBotRepository } from "../persistence/Services/ProjectionBots.ts";
import { ProjectionMcpServerRepository } from "../persistence/Services/ProjectionMcpServers.ts";
import { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";
import {
  RoutineRuntimeAdapter,
  type RoutineDependencyFailure,
  type RoutineRuntimeAdapterShape,
} from "./types.ts";

export const findBlockingDependencyIncident = (
  incidents: ReadonlyArray<BotInboxItem>,
  botId: BotInboxItem["botId"],
  connectorDependencies: ReadonlyArray<string>,
) =>
  incidents.find((incident) => {
    if (
      incident.botId !== botId ||
      incident.status !== "open" ||
      (incident.kind !== "oauth-expired" &&
        incident.kind !== "connector-failure" &&
        incident.kind !== "browser-dead")
    ) {
      return false;
    }
    const [, dependencyId] = incident.incidentKey.split(":");
    if (!dependencyId) return false;
    return connectorDependencies.some(
      (id) => id === dependencyId || `mcp-${id}` === dependencyId || id === `mcp-${dependencyId}`,
    );
  });

const make = Effect.gen(function* () {
  const engine = yield* OrchestrationEngineService;
  const bots = yield* ProjectionBotRepository;
  const mcpServers = yield* ProjectionMcpServerRepository;
  const snapshots = yield* ProjectionSnapshotQuery;
  const providers = yield* ProviderRegistry;
  const fileSystem = yield* FileSystem.FileSystem;
  const config = yield* ServerConfig;
  const inbox = BotInboxService.forSecretsDir(config.secretsDir);
  const subscriptionAuth = SubscriptionAuthService.forSecretsDir(config.secretsDir);

  const dispatch = (command: OrchestrationCommand) => engine.dispatch(command);

  const isTargetBusy: RoutineRuntimeAdapterShape["isTargetBusy"] = (routine) =>
    snapshots.getThreadShellById(routine.targetThreadId).pipe(
      Effect.map(
        Option.match({
          onNone: () => false,
          onSome: (thread) =>
            thread.latestTurn?.state === "running" ||
            thread.session?.status === "starting" ||
            thread.session?.status === "running",
        }),
      ),
      Effect.orDie,
    );

  const checkDependencies: RoutineRuntimeAdapterShape["checkDependencies"] = (routine) =>
    Effect.gen(function* () {
      const bot = yield* bots.getById({ botId: routine.botId });
      if (Option.isNone(bot) || bot.value.archivedAt !== null) {
        return {
          kind: "bot",
          reason: "The assigned bot is archived or missing.",
          nextAction: "Restore the bot, then resume the routine.",
        } satisfies RoutineDependencyFailure;
      }

      const target = yield* snapshots.getThreadShellById(routine.targetThreadId);
      if (
        Option.isNone(target) ||
        target.value.archivedAt !== null ||
        target.value.projectId !== routine.projectId ||
        target.value.botId !== routine.botId
      ) {
        return {
          kind: "workspace",
          reason: "The routine chat is unavailable.",
          nextAction: "Restore the bot chat, then resume the routine.",
        } satisfies RoutineDependencyFailure;
      }

      inbox.reload();
      const dependencyIncident = findBlockingDependencyIncident(
        inbox.list(),
        routine.botId,
        routine.connectorDependencies,
      );
      if (dependencyIncident !== undefined) {
        return {
          kind: dependencyIncident.kind === "browser-dead" ? "browser" : "connector",
          reason: dependencyIncident.lastFailure,
          nextAction: dependencyIncident.nextAction,
        } satisfies RoutineDependencyFailure;
      }

      const project = yield* snapshots.getProjectShellById(routine.projectId);
      if (Option.isNone(project) || !(yield* fileSystem.exists(project.value.workspaceRoot))) {
        return {
          kind: "workspace",
          reason: "The routine workspace is unavailable.",
          nextAction: "Restore the project workspace, then resume the routine.",
        } satisfies RoutineDependencyFailure;
      }

      const readModel = yield* snapshots.getCommandReadModel();
      const missingSkill = routine.skillAssignmentIds.find(
        (id) =>
          !(readModel.skillAssignments ?? []).some(
            (assignment) => assignment.id === id && assignment.botId === routine.botId,
          ),
      );
      if (missingSkill !== undefined) {
        return {
          kind: "bot",
          reason: `Assigned skill '${missingSkill}' is unavailable.`,
          nextAction: "Assign the skill again, then resume the routine.",
        } satisfies RoutineDependencyFailure;
      }

      const configuredMcpServers = yield* mcpServers.listAll();
      const unavailableConnector = routine.connectorDependencies.find(
        (id) => !configuredMcpServers.some((server) => server.id === id && server.enabled),
      );
      if (unavailableConnector !== undefined) {
        return {
          kind: "connector",
          reason: `Required connector '${unavailableConnector}' is unavailable.`,
          nextAction: "Enable or reconnect the connector, then resume the routine.",
        } satisfies RoutineDependencyFailure;
      }

      const unhealthySubscription = routine.connectorDependencies.find((id) => {
        if (!isSubscriptionProviderId(id)) return false;
        const status = subscriptionAuth.statuses().find((entry) => entry.provider === id);
        return (
          status !== undefined &&
          ["expired", "revoked", "failed", "failed-first-request"].includes(status.health)
        );
      });
      if (unhealthySubscription !== undefined) {
        return {
          kind: "connector",
          reason: `Required connector '${unhealthySubscription}' needs attention.`,
          nextAction: "Reconnect the connector, then resume the routine.",
        } satisfies RoutineDependencyFailure;
      }

      const providerInstanceId = target.value.modelSelection.instanceId;
      const providerSnapshots = yield* providers.getProviders;
      if (!providerSnapshots.some((provider) => provider.instanceId === providerInstanceId)) {
        return {
          kind: "provider",
          reason: `Provider '${providerInstanceId}' is unavailable.`,
          nextAction: "Reconnect the provider, then resume the routine.",
        } satisfies RoutineDependencyFailure;
      }

      if (routine.sandbox !== "local") {
        return {
          kind: "execution",
          reason: `Sandbox '${routine.sandbox}' is unavailable.`,
          nextAction: "Restore the sandbox provider, then resume the routine.",
        } satisfies RoutineDependencyFailure;
      }

      inbox.resolve(`routine:${routine.id}`);
      return null;
    }).pipe(Effect.orDie);

  const recordQueued: RoutineRuntimeAdapterShape["recordQueued"] = (run) =>
    run.trigger === "scheduled" || run.trigger === "missed"
      ? dispatch({
          type: "routine.run.scheduled",
          commandId: CommandId.make(`server:routine.run:${run.routineId}:${run.scheduledFor}`),
          routineId: run.routineId,
          runId: run.id,
          trigger: run.trigger,
          scheduledFor: run.scheduledFor,
          createdAt: run.createdAt,
        }).pipe(Effect.asVoid, Effect.orDie)
      : Effect.void;

  const recordBlocked: RoutineRuntimeAdapterShape["recordBlocked"] = (run, failure) =>
    DateTime.now.pipe(
      Effect.flatMap((now) =>
        dispatch({
          type: "routine.run.block",
          commandId: CommandId.make(`server:routine.block:${run.id}`),
          routineId: run.routineId,
          runId: run.id,
          failure: { kind: failure.kind, message: failure.reason },
          createdAt: DateTime.formatIso(now),
        }),
      ),
      Effect.asVoid,
      Effect.orDie,
    );

  const recordCompleted: RoutineRuntimeAdapterShape["recordCompleted"] = (
    run,
    nextRunAt,
    summary,
    completedAt,
  ) =>
    dispatch({
      type: "routine.run.complete",
      commandId: CommandId.make(`server:routine.complete:${run.id}`),
      routineId: run.routineId,
      runId: run.id,
      result: { summary },
      usageRef: null,
      nextRunAt,
      createdAt: completedAt,
    }).pipe(Effect.asVoid, Effect.orDie);

  const recordFailed: RoutineRuntimeAdapterShape["recordFailed"] = (run, failure, completedAt) =>
    dispatch({
      type: "routine.run.fail",
      commandId: CommandId.make(`server:routine.fail:${run.id}`),
      routineId: run.routineId,
      runId: run.id,
      failure: { kind: failure.kind, message: failure.reason },
      usageRef: null,
      createdAt: completedAt,
    }).pipe(Effect.asVoid, Effect.orDie);

  const openFailureIncident: RoutineRuntimeAdapterShape["openFailureIncident"] = (
    routine,
    failure,
  ) =>
    Effect.gen(function* () {
      const bot = yield* bots.getById({ botId: routine.botId });
      inbox.ensureOpen({
        incidentKey: `routine:${routine.id}`,
        kind: "routine-failure",
        botId: routine.botId,
        botName: Option.isSome(bot) ? bot.value.name : "Bot",
        taskOrRoutine: routine.job,
        lastFailure: failure.reason,
        nextAction: failure.nextAction,
      });
    }).pipe(Effect.orDie);

  const resolveFailureIncident: RoutineRuntimeAdapterShape["resolveFailureIncident"] = (
    routineId,
  ) => Effect.sync(() => void inbox.resolve(`routine:${routineId}`));

  const dispatchTurn: RoutineRuntimeAdapterShape["dispatchTurn"] = (routine, run) =>
    Effect.gen(function* () {
      const threadRef = routine.targetThreadId;
      const createdAt = DateTime.formatIso(yield* DateTime.now);
      yield* dispatch({
        type: "routine.run.start",
        commandId: CommandId.make(`server:routine.start:${run.id}`),
        routineId: routine.id,
        runId: run.id,
        threadRef,
        startedAt: createdAt,
      });
      yield* dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make(`server:routine.turn:${run.id}`),
        threadId: threadRef,
        message: {
          messageId: MessageId.make(`routine:${run.id}:message`),
          role: "user",
          text: `Execute this routine now. Do not create or change a schedule.\n\n${routine.procedure}`,
          attachments: [],
        },
        runtimeMode: routine.approvalPolicy,
        interactionMode: "default",
        createdAt,
      });
      return { threadRef };
    }).pipe(Effect.orDie);

  return {
    checkDependencies,
    isTargetBusy,
    recordQueued,
    recordBlocked,
    recordCompleted,
    recordFailed,
    openFailureIncident,
    resolveFailureIncident,
    dispatchTurn,
  } satisfies RoutineRuntimeAdapterShape;
});

export const RoutineRuntimeAdapterLive = Layer.effect(RoutineRuntimeAdapter, make);
