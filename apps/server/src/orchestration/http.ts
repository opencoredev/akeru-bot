import {
  AuthAccessWriteScope,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  EnvironmentHttpApi,
  ProviderInstanceId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";

import * as ChannelCommand from "../channels/ChannelCommand.ts";
import * as ChannelRuntime from "../channels/ChannelRuntime.ts";
import * as ServerRuntimeStartup from "../serverRuntimeStartup.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ServerConfig from "../config.ts";
import * as ProjectionBots from "../persistence/Services/ProjectionBots.ts";
import * as ProjectionGroups from "../persistence/Services/ProjectionGroups.ts";
import { OrchestrationCommandReceiptRepository } from "../persistence/Services/OrchestrationCommandReceipts.ts";
import * as ProviderRegistry from "../provider/Services/ProviderRegistry.ts";
import { deriveProviderInstanceConfigMap } from "../provider/Layers/ProviderInstanceRegistryHydration.ts";
import { preflightProvider } from "../provider/providerPreflight.ts";
import { SubscriptionAuthService } from "../subscription-auth/service.ts";
import { BotUsageLedger } from "../usage/BotUsageLedger.ts";
import { resolveGroupResponderBotId } from "./groupResponder.ts";
import { projectThreadDetailSnapshot } from "./ActivityPayloadProjection.ts";
import {
  applyAuthenticatedCommandActor,
  applyKnownGroupPerson,
  canManageGroupPeople,
} from "./AuthenticatedCommand.ts";
import { cleanupFailedUploadedAttachments, normalizeDispatchCommand } from "./Normalizer.ts";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import {
  annotateEnvironmentRequest,
  failEnvironmentScopeRequired,
  failEnvironmentInternal,
  failEnvironmentInvalidRequest,
  failEnvironmentNotFound,
  requireEnvironmentScope,
} from "../auth/http.ts";
import { OrchestrationEngineService } from "./Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "./Services/ProjectionSnapshotQuery.ts";

export const orchestrationHttpApiLayer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "orchestration",
  Effect.fnUntraced(function* (handlers) {
    const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
    const orchestrationEngine = yield* OrchestrationEngineService;
    const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
    const projectionBots = yield* ProjectionBots.ProjectionBotRepository;
    const projectionGroups = yield* ProjectionGroups.ProjectionGroupRepository;
    const commandReceipts = yield* OrchestrationCommandReceiptRepository;
    const providerRegistry = yield* Effect.serviceOption(ProviderRegistry.ProviderRegistry);
    const botUsageLedger = yield* BotUsageLedger;
    const config = yield* ServerConfig.ServerConfig;
    const subscriptionAuth = yield* SubscriptionAuthService.forSecretsDir(config.secretsDir);
    const serverSettings = yield* Effect.serviceOption(ServerSettings.ServerSettingsService);
    const channelRuntime = yield* Effect.serviceOption(ChannelRuntime.ChannelRuntime);
    const startup = yield* Effect.serviceOption(ServerRuntimeStartup.ServerRuntimeStartup);

    return handlers
      .handle(
        "snapshot",
        Effect.fn("environment.orchestration.snapshot")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          // Serve the lightweight command read model (thread bodies empty)
          // instead of the fully hydrated snapshot. Hydrating every message
          // and activity payload in the database has OOM-killed servers, and
          // the route's only consumer (the project CLI) reads projects alone —
          // UI clients load the shell and per-thread snapshots instead.
          return yield* projectionSnapshotQuery
            .getCommandReadModel()
            .pipe(
              Effect.catch((cause) =>
                failEnvironmentInternal("orchestration_snapshot_failed", cause),
              ),
            );
        }),
      )
      .handle(
        "shellSnapshot",
        Effect.fn("environment.orchestration.shellSnapshot")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          return yield* projectionSnapshotQuery.getShellSnapshot().pipe(
            Effect.map((snapshot) => ({
              ...snapshot,
              bots: snapshot.bots.map((bot) => ({
                ...bot,
                channelBindings: Option.match(channelRuntime, {
                  onNone: () =>
                    ChannelRuntime.channelBindingsForRuntime(bot.channelBindings, () => false),
                  onSome: (runtime) => runtime.channelBindingsForRuntime(bot.channelBindings),
                }),
              })),
            })),
            Effect.catch((cause) =>
              failEnvironmentInternal("orchestration_snapshot_failed", cause),
            ),
          );
        }),
      )
      .handle(
        "threadSnapshot",
        Effect.fn("environment.orchestration.threadSnapshot")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          const snapshot = yield* projectionSnapshotQuery
            .getThreadDetailSnapshot(
              args.params.threadId,
              args.payload.turnLimit === undefined
                ? undefined
                : {
                    turnLimit: args.payload.turnLimit,
                    ...(args.payload.beforeCursor !== undefined
                      ? { beforeCursor: args.payload.beforeCursor }
                      : {}),
                  },
            )
            .pipe(
              Effect.catch((cause) =>
                failEnvironmentInternal("orchestration_thread_snapshot_failed", cause),
              ),
            );
          if (Option.isNone(snapshot)) {
            return yield* failEnvironmentNotFound("thread_not_found");
          }
          return projectThreadDetailSnapshot(snapshot.value);
        }),
      )
      .handle(
        "dispatch",
        Effect.fn("environment.orchestration.dispatch")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          const principal = yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
          const command = args.payload;
          if (ChannelCommand.isChannelCommand(command)) {
            if (!principal.scopes.has(AuthAccessWriteScope)) {
              yield* requireEnvironmentScope(AuthAccessWriteScope);
            }
            const services = Option.all({ channelRuntime, startup });
            if (Option.isNone(services)) {
              return yield* failEnvironmentInternal(
                "orchestration_dispatch_failed",
                new Error("Channel services are unavailable."),
              );
            }
            return yield* services.value.startup
              .enqueueCommand(
                ChannelCommand.executeChannelCommand(services.value.channelRuntime, command),
              )
              .pipe(
                // The log gets the category only; channel errors can wrap provider responses.
                Effect.catchCause((cause) =>
                  ChannelCommand.channelCommandFailure(command, cause).pipe(
                    Effect.flatMap((failure) =>
                      failEnvironmentInternal("orchestration_dispatch_failed", {
                        channelFailureCategory: failure.category ?? "internal",
                      }),
                    ),
                  ),
                ),
              );
          }
          const decodedCommand = yield* normalizeDispatchCommand(command).pipe(
            Effect.catch(() => failEnvironmentInvalidRequest("invalid_command")),
          );
          if (!canManageGroupPeople(decodedCommand, principal.scopes)) {
            return yield* failEnvironmentScopeRequired(AuthAccessWriteScope);
          }
          const needsPeople =
            decodedCommand.type === "group.create" ||
            decodedCommand.type === "group.leave" ||
            decodedCommand.type === "group.person.assign" ||
            decodedCommand.type === "group.person.unassign" ||
            decodedCommand.type === "thread.turn.start";
          const clientSessions = needsPeople
            ? yield* serverAuth
                .listClientSessions(principal.sessionId)
                .pipe(
                  Effect.catch((cause) =>
                    failEnvironmentInternal("orchestration_dispatch_failed", cause),
                  ),
                )
            : [];
          const currentClient = clientSessions.find(
            (session) => session.sessionId === principal.sessionId,
          );
          const actor = {
            personId: principal.sessionId,
            displayName:
              currentClient?.client.label ??
              (principal.scopes.has(AuthAccessWriteScope) ? "Host" : "Paired person"),
            canManageGroups: principal.scopes.has(AuthAccessWriteScope),
          };
          const actorCommand = applyAuthenticatedCommandActor(decodedCommand, actor);
          const normalizedCommand = applyKnownGroupPerson(actorCommand, clientSessions);
          if (!normalizedCommand) {
            return yield* failEnvironmentInvalidRequest("invalid_command");
          }
          // Bot engines bypass the turn preflight, so a changed engine is
          // checked here as in WebSocket dispatch. Only an unknown model
          // blocks the save; a missing provider is not evidence of that.
          if (
            (normalizedCommand.type === "bot.create" || normalizedCommand.type === "bot.update") &&
            normalizedCommand.engine &&
            Option.isSome(providerRegistry)
          ) {
            const engine = normalizedCommand.engine;
            const existingBot =
              normalizedCommand.type === "bot.update"
                ? yield* projectionBots.getById({ botId: normalizedCommand.botId }).pipe(
                    Effect.map(Option.getOrUndefined),
                    Effect.catch((cause) =>
                      failEnvironmentInternal("orchestration_dispatch_failed", cause),
                    ),
                  )
                : undefined;
            const engineChanged =
              existingBot === undefined ||
              existingBot.engine?.provider !== engine.provider ||
              existingBot.engine?.model !== engine.model;
            if (engineChanged) {
              const verdict = preflightProvider({
                providers: yield* providerRegistry.value.getProviders,
                providerId: engine.provider,
                model: engine.model,
                subscriptionStatuses: subscriptionAuth.statuses(),
                subscriptionHealth: (instanceId) =>
                  subscriptionAuth.providerInstanceRequestHealth(instanceId),
                now: yield* Clock.currentTimeMillis,
                requireSettledCatalog: true,
              });
              if (verdict?.category === "unsupported-model") {
                return yield* failEnvironmentInvalidRequest("invalid_command", {
                  detail: verdict.detail,
                  unavailability: verdict.category,
                });
              }
            }
          }
          const shouldPreflightTurn =
            normalizedCommand.type === "thread.turn.start" &&
            Option.isNone(
              yield* commandReceipts
                .getByCommandId({ commandId: normalizedCommand.commandId })
                .pipe(
                  Effect.catch((cause) =>
                    failEnvironmentInternal("orchestration_dispatch_failed", cause),
                  ),
                ),
            );
          if (shouldPreflightTurn && normalizedCommand.type === "thread.turn.start") {
            if (Option.isNone(providerRegistry)) {
              return yield* failEnvironmentInternal(
                "orchestration_dispatch_failed",
                new Error("Provider registry is unavailable."),
              );
            }
            const thread = yield* projectionSnapshotQuery
              .getThreadShellById(normalizedCommand.threadId)
              .pipe(
                Effect.map(Option.getOrUndefined),
                Effect.catch((cause) =>
                  failEnvironmentInternal("orchestration_dispatch_failed", cause),
                ),
              );
            const bootstrapThread = normalizedCommand.bootstrap?.createThread;
            const groupId = thread?.groupId ?? bootstrapThread?.groupId;
            const group = groupId
              ? yield* projectionGroups.getById({ groupId }).pipe(
                  Effect.map(Option.getOrUndefined),
                  Effect.catch((cause) =>
                    failEnvironmentInternal("orchestration_dispatch_failed", cause),
                  ),
                )
              : undefined;
            const botId = groupId
              ? group
                ? yield* resolveGroupResponderBotId({
                    group,
                    respondingBotId: normalizedCommand.respondingBotId,
                    text: normalizedCommand.message.text,
                    isActive: (candidate) =>
                      projectionBots.getById({ botId: candidate }).pipe(
                        Effect.map(
                          (found) => Option.isSome(found) && found.value.archivedAt === null,
                        ),
                        Effect.catch((cause) =>
                          failEnvironmentInternal("orchestration_dispatch_failed", cause),
                        ),
                      ),
                  })
                : normalizedCommand.respondingBotId
              : (thread?.botId ?? bootstrapThread?.botId ?? normalizedCommand.respondingBotId);
            const bot = botId
              ? yield* projectionBots.getById({ botId }).pipe(
                  Effect.map(Option.getOrUndefined),
                  Effect.catch((cause) =>
                    failEnvironmentInternal("orchestration_dispatch_failed", cause),
                  ),
                )
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
              const providerInstanceConfig = Option.isSome(serverSettings)
                ? deriveProviderInstanceConfigMap(
                    yield* serverSettings.value.getSettings.pipe(
                      Effect.catch((cause) =>
                        failEnvironmentInternal("orchestration_dispatch_failed", cause),
                      ),
                    ),
                  )[ProviderInstanceId.make(providerId)]
                : undefined;
              const verdict = preflightProvider({
                providers: yield* providerRegistry.value.getProviders,
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
                return yield* failEnvironmentInvalidRequest("invalid_command", {
                  detail: verdict.detail,
                  unavailability: verdict.category,
                  ...(verdict.category === "missing-login" || verdict.category === "expired-login"
                    ? { repairAction: "providers" }
                    : {}),
                });
              }
            }
            if (bot?.usageCap) {
              const usage = yield* botUsageLedger
                .summarize(bot.botId)
                .pipe(
                  Effect.catch((cause) =>
                    failEnvironmentInternal("orchestration_dispatch_failed", cause),
                  ),
                );
              if (usage.consumedTokens + usage.reservedTokens >= bot.usageCap.limit) {
                yield* cleanupFailedUploadedAttachments(command, normalizedCommand);
                return yield* failEnvironmentInvalidRequest("invalid_command", {
                  detail: `Usage cap reached for ${bot.name}.`,
                  unavailability: "usage-cap",
                  repairAction: "usage",
                });
              }
            }
          }
          return yield* orchestrationEngine.dispatch(normalizedCommand, { actor }).pipe(
            Effect.tapError(() =>
              cleanupFailedUploadedAttachments(args.payload, normalizedCommand),
            ),
            Effect.catch((cause) =>
              failEnvironmentInternal("orchestration_dispatch_failed", cause),
            ),
          );
        }),
      );
  }),
);
