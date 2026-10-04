import type * as RpcGroup from "effect/unstable/rpc/RpcGroup";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import {
  AuthAccessWriteScope,
  CommandId,
  OrchestrationDispatchCommandError,
  OrchestrationGetFullThreadDiffError,
  OrchestrationGetSnapshotError,
  OrchestrationSearchThreadsError,
  OrchestrationGetTurnDiffError,
  ORCHESTRATION_WS_METHODS,
  ProviderInstanceId,
  WsRpcGroup,
} from "@akeru/contracts";
import { deriveProviderInstanceConfigMap } from "./provider/Layers/ProviderInstanceRegistryHydration.ts";
import * as ChannelCommand from "./channels/ChannelCommand.ts";
import {
  applyAuthenticatedCommandActor,
  applyKnownGroupPerson,
  canManageGroupPeople,
} from "./orchestration/AuthenticatedCommand.ts";
import {
  cleanupFailedUploadedAttachments,
  dispatchKeepingAcceptedUploads,
  normalizeDispatchCommand,
} from "./orchestration/Normalizer.ts";
import { resolveGroupResponderBotId } from "./orchestration/groupResponder.ts";
import { readWorkflowScript } from "./orchestration/workflowScriptQuery.ts";
import { preflightProvider } from "./provider/providerPreflight.ts";

import { isOrchestrationDispatchCommandError, nowIso } from "./wsSupport.ts";
import type { WsConnection } from "./wsConnection.ts";

export const createWsOrchestrationHandlers = ({
  currentSessionId,
  projectionSnapshotQuery,
  projectionBots,
  projectionGroups,
  checkpointDiffQuery,
  providerRegistry,
  subscriptionAuth,
  serverSettings,
  startup,
  serverAuth,
  commandReceipts,
  channelRuntime,
  channelBindingsForRuntime,
  observeRpcEffect,
  loadEnvironmentPeople,
  currentSession,
  dispatchNormalizedCommand,
}: Pick<
  WsConnection,
  | "currentSessionId"
  | "projectionSnapshotQuery"
  | "projectionBots"
  | "projectionGroups"
  | "checkpointDiffQuery"
  | "providerRegistry"
  | "subscriptionAuth"
  | "serverSettings"
  | "startup"
  | "serverAuth"
  | "commandReceipts"
  | "channelRuntime"
  | "channelBindingsForRuntime"
  | "usage"
  | "observeRpcEffect"
  | "loadEnvironmentPeople"
  | "currentSession"
  | "dispatchNormalizedCommand"
>) =>
  ({
    [ORCHESTRATION_WS_METHODS.dispatchCommand]: (command) =>
      observeRpcEffect(
        ORCHESTRATION_WS_METHODS.dispatchCommand,
        Effect.gen(function* () {
          if (ChannelCommand.isChannelCommand(command)) {
            if (!currentSession.scopes.includes(AuthAccessWriteScope)) {
              return yield* new OrchestrationDispatchCommandError({
                message: "Only the environment host can manage external channels.",
              });
            }

            if (Option.isNone(channelRuntime)) {
              return yield* new OrchestrationDispatchCommandError({
                message: "Channel delivery storage is unavailable.",
              });
            }

            return yield* startup.enqueueCommand(
              ChannelCommand.executeChannelCommand(channelRuntime.value, command).pipe(
                Effect.catchCause((cause) =>
                  ChannelCommand.channelCommandFailure(command, cause).pipe(
                    Effect.flatMap((failure) =>
                      Effect.fail(ChannelCommand.channelDispatchError(failure)),
                    ),
                  ),
                ),
              ),
            );
          }

          const decodedCommand = yield* normalizeDispatchCommand(command);

          const currentPerson =
            decodedCommand.type === "group.create" ||
            decodedCommand.type === "group.leave" ||
            decodedCommand.type === "thread.turn.start"
              ? yield* loadEnvironmentPeople().pipe(Effect.map((people) => people.current))
              : undefined;

          const actorCommand = applyAuthenticatedCommandActor(decodedCommand, {
            personId: currentSessionId,
            displayName: currentPerson?.displayName ?? "Paired person",
            canManageGroups: currentSession.scopes.includes(AuthAccessWriteScope),
          });

          let normalizedCommand = actorCommand;

          if (
            actorCommand.type === "group.person.assign" ||
            actorCommand.type === "group.person.unassign"
          ) {
            if (!canManageGroupPeople(actorCommand, currentSession.scopes)) {
              return yield* new OrchestrationDispatchCommandError({
                message: "Managing group people requires access:write.",
              });
            }

            const clientSessions = yield* serverAuth.listClientSessions(currentSessionId);
            const knownPersonCommand = applyKnownGroupPerson(actorCommand, clientSessions);

            if (!knownPersonCommand) {
              return yield* new OrchestrationDispatchCommandError({
                message: "Only a paired person can be changed in a group.",
              });
            }

            normalizedCommand = knownPersonCommand;
          }

          // Bot engines bypass the thread.turn.start preflight (the
          // decider overwrites the command's modelSelection with the
          // bot engine), so validate the slug here while the provider
          // snapshot is available. A missing provider or empty model
          // list is not evidence the model is unknown. On bot.update the
          // check only runs when the engine actually changes, so a model
          // that dropped out of the catalog cannot block unrelated saves.
          const existingBot =
            normalizedCommand.type === "bot.update"
              ? yield* projectionBots
                  .getById({ botId: normalizedCommand.botId })
                  .pipe(Effect.map(Option.getOrUndefined))
              : undefined;

          const engineForValidation =
            normalizedCommand.type === "bot.create" || normalizedCommand.type === "bot.update"
              ? (normalizedCommand.engine ?? undefined)
              : undefined;

          const engineChanged =
            engineForValidation !== undefined &&
            (existingBot === undefined ||
              existingBot.engine?.provider !== engineForValidation.provider ||
              existingBot.engine?.model !== engineForValidation.model);

          if (engineForValidation !== undefined && engineChanged) {
            const engine = engineForValidation;

            const verdict = preflightProvider({
              providers: yield* providerRegistry.getProviders,
              providerId: engine.provider,
              model: engine.model,
              subscriptionStatuses: subscriptionAuth.statuses(),
              subscriptionHealth: (instanceId) =>
                subscriptionAuth.providerInstanceRequestHealth(instanceId),
              now: yield* Clock.currentTimeMillis,
              requireSettledCatalog: true,
            });

            if (verdict?.category === "unsupported-model") {
              return yield* new OrchestrationDispatchCommandError({
                message: verdict.detail,
                unavailability: verdict.category,
              });
            }
          }

          // A retried turn the engine already accepted replays its receipt, so
          // provider and cap gates must not turn that success into a failure.
          const alreadyAccepted =
            normalizedCommand.type === "thread.turn.start" && Option.isSome(commandReceipts)
              ? yield* commandReceipts.value
                  .getByCommandId({ commandId: normalizedCommand.commandId })
                  .pipe(
                    Effect.map(
                      (receipt) =>
                        Option.isSome(receipt) &&
                        receipt.value.status === "accepted" &&
                        receipt.value.aggregateId === normalizedCommand.threadId,
                    ),
                    Effect.orElseSucceed(() => false),
                  )
              : false;

          if (normalizedCommand.type === "thread.turn.start" && !alreadyAccepted) {
            const thread = yield* projectionSnapshotQuery
              .getThreadShellById(normalizedCommand.threadId)
              .pipe(Effect.map(Option.getOrUndefined));

            const bootstrapThread = normalizedCommand.bootstrap?.createThread;
            const groupId = thread?.groupId ?? bootstrapThread?.groupId;

            const group = groupId
              ? yield* projectionGroups.getById({ groupId }).pipe(Effect.map(Option.getOrUndefined))
              : undefined;

            const botId = groupId
              ? group
                ? yield* resolveGroupResponderBotId({
                    group,
                    respondingBotId: normalizedCommand.respondingBotId,
                    text: normalizedCommand.message.text,
                    isActive: (candidate) =>
                      projectionBots
                        .getById({ botId: candidate })
                        .pipe(
                          Effect.map(
                            (found) => Option.isSome(found) && found.value.archivedAt === null,
                          ),
                        ),
                  })
                : normalizedCommand.respondingBotId
              : (thread?.botId ?? bootstrapThread?.botId ?? normalizedCommand.respondingBotId);

            const bot = botId
              ? yield* projectionBots.getById({ botId }).pipe(Effect.map(Option.getOrUndefined))
              : undefined;

            const selection = bot?.engine
              ? {
                  instanceId: ProviderInstanceId.make(bot.engine.provider),
                  model: bot.engine.model,
                }
              : (normalizedCommand.modelSelection ??
                thread?.modelSelection ??
                bootstrapThread?.modelSelection);

            const providerId = selection?.instanceId ?? thread?.session?.providerName;
            const model = selection?.model ?? "";

            if (providerId && model) {
              const providerInstanceConfig = deriveProviderInstanceConfigMap(
                yield* serverSettings.getSettings,
              )[ProviderInstanceId.make(providerId)];

              const verdict = preflightProvider({
                providers: yield* providerRegistry.getProviders,
                providerId,
                model,
                ...(providerInstanceConfig ? { providerInstanceConfig } : {}),
                subscriptionStatusForInstance: (subscriptionProvider, instanceId) =>
                  subscriptionAuth.accountStatus(subscriptionProvider, instanceId),
                subscriptionHealth: (instanceId) =>
                  subscriptionAuth.providerInstanceRequestHealth(instanceId),
                now: yield* Clock.currentTimeMillis,
                requireSettledCatalog: true,
              });

              if (verdict) {
                yield* cleanupFailedUploadedAttachments(command, normalizedCommand);

                return yield* new OrchestrationDispatchCommandError({
                  message: verdict.detail,
                  unavailability: verdict.category,
                  ...(verdict.repairAction ? { repairAction: verdict.repairAction } : {}),
                });
              }
            }
          }

          // Archive and settle both mean "done with this thread", so a
          // live provider session must not keep running background work
          // (PR monitors, dev servers, subagent fleets) after either
          // lands. The decider rejects settling a starting/running
          // session, so for settle this only ever stops an idle one; a
          // stopped session-set does not count as activity, so the stop
          // cannot un-settle the thread it follows.
          const parkingCommand =
            normalizedCommand.type === "thread.archive" ||
            normalizedCommand.type === "thread.settle"
              ? normalizedCommand
              : undefined;

          // Best-effort on purpose: the user's archive/settle must not
          // fail because this cleanup read blipped, so a failed read
          // logs and skips the stop instead of propagating.
          const shouldStopSessionAfterCommand = parkingCommand
            ? yield* projectionSnapshotQuery.getThreadShellById(parkingCommand.threadId).pipe(
                Effect.map(
                  Option.match({
                    onNone: () => false,
                    onSome: (thread) =>
                      thread.session !== null && thread.session.status !== "stopped",
                  }),
                ),
                Effect.catchCause((cause) =>
                  Effect.logWarning(
                    "failed to read thread session state before session-stop check",
                    { threadId: parkingCommand.threadId, cause },
                  ).pipe(Effect.as(false)),
                ),
              )
            : false;

          // Startup readiness is awaited first so the engine dispatch itself
          // runs inline instead of from the startup queue. A bootstrap stays
          // cancellable because it awaits its own engine dispatches.
          const result = yield* dispatchKeepingAcceptedUploads({
            command,
            normalizedCommand,
            awaitReady: startup.awaitCommandReady,
            dispatch: dispatchNormalizedCommand(normalizedCommand),
            interruptible:
              normalizedCommand.type === "thread.turn.start" && !!normalizedCommand.bootstrap,
            receipts: commandReceipts,
          });

          if (parkingCommand) {
            const parkingKind = parkingCommand.type === "thread.archive" ? "archive" : "settle";

            if (shouldStopSessionAfterCommand) {
              yield* Effect.gen(function* () {
                const stopCommand = yield* normalizeDispatchCommand({
                  type: "thread.session.stop",
                  commandId: CommandId.make(
                    `session-stop-for-${parkingKind}:${parkingCommand.commandId}`,
                  ),
                  threadId: parkingCommand.threadId,
                  createdAt: yield* nowIso,
                  // A settled thread can be re-engaged before this stop is
                  // decided; the decider then drops the stop instead of
                  // killing the new session. Archive stops stay
                  // unconditional: turn starts on archived threads are
                  // rejected, so there is no new session to protect.
                  ...(parkingKind === "settle" ? { onlyIfSettled: true } : {}),
                });

                yield* dispatchNormalizedCommand(stopCommand);
              }).pipe(
                Effect.catchCause((cause) =>
                  Effect.logWarning(`failed to stop provider session during ${parkingKind}`, {
                    threadId: parkingCommand.threadId,
                    cause,
                  }),
                ),
              );
            }
          }

          return result;
        }).pipe(
          Effect.mapError((cause) =>
            isOrchestrationDispatchCommandError(cause)
              ? cause
              : new OrchestrationDispatchCommandError({
                  message: "Failed to dispatch orchestration command",
                  cause,
                }),
          ),
        ),
        { "rpc.aggregate": "orchestration" },
      ),

    [ORCHESTRATION_WS_METHODS.getWorkflowScript]: (input) =>
      observeRpcEffect(
        ORCHESTRATION_WS_METHODS.getWorkflowScript,
        readWorkflowScript({ scriptPath: input.scriptPath }),
        { "rpc.aggregate": "orchestration" },
      ),

    [ORCHESTRATION_WS_METHODS.getTurnDiff]: (input) =>
      observeRpcEffect(
        ORCHESTRATION_WS_METHODS.getTurnDiff,
        checkpointDiffQuery.getTurnDiff(input).pipe(
          Effect.mapError(
            (cause) =>
              new OrchestrationGetTurnDiffError({
                message: "Failed to load turn diff",
                cause,
              }),
          ),
        ),
        { "rpc.aggregate": "orchestration" },
      ),

    [ORCHESTRATION_WS_METHODS.getFullThreadDiff]: (input) =>
      observeRpcEffect(
        ORCHESTRATION_WS_METHODS.getFullThreadDiff,
        checkpointDiffQuery.getFullThreadDiff(input).pipe(
          Effect.mapError(
            (cause) =>
              new OrchestrationGetFullThreadDiffError({
                message: "Failed to load the full chat diff",
                cause,
              }),
          ),
        ),
        { "rpc.aggregate": "orchestration" },
      ),

    [ORCHESTRATION_WS_METHODS.searchThreads]: (input) =>
      observeRpcEffect(
        ORCHESTRATION_WS_METHODS.searchThreads,
        projectionSnapshotQuery.searchThreads(input).pipe(
          Effect.mapError(
            (cause) =>
              new OrchestrationSearchThreadsError({
                message: "Failed to search conversations",
                cause,
              }),
          ),
        ),
        { "rpc.aggregate": "orchestration" },
      ),

    [ORCHESTRATION_WS_METHODS.getArchivedShellSnapshot]: (_input) =>
      observeRpcEffect(
        ORCHESTRATION_WS_METHODS.getArchivedShellSnapshot,
        projectionSnapshotQuery.getArchivedShellSnapshot().pipe(
          Effect.map((snapshot) => ({
            ...snapshot,
            bots: snapshot.bots.map((bot) => ({
              ...bot,
              channelBindings: channelBindingsForRuntime(bot.channelBindings ?? []),
            })),
          })),
          Effect.tapError((cause) =>
            Effect.logError("orchestration archived shell snapshot load failed", { cause }),
          ),
          Effect.mapError(
            (cause) =>
              new OrchestrationGetSnapshotError({
                message: "Failed to load archived orchestration shell snapshot",
                cause,
              }),
          ),
        ),
        { "rpc.aggregate": "orchestration" },
      ),
  }) satisfies Pick<
    RpcGroup.HandlersFrom<RpcGroup.Rpcs<typeof WsRpcGroup>>,
    | typeof ORCHESTRATION_WS_METHODS.dispatchCommand
    | typeof ORCHESTRATION_WS_METHODS.getWorkflowScript
    | typeof ORCHESTRATION_WS_METHODS.getTurnDiff
    | typeof ORCHESTRATION_WS_METHODS.getFullThreadDiff
    | typeof ORCHESTRATION_WS_METHODS.searchThreads
    | typeof ORCHESTRATION_WS_METHODS.getArchivedShellSnapshot
  >;
