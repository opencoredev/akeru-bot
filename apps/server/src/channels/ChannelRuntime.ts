import { BotId, ChannelConnectionId } from "@akeru/contracts";
import { Context } from "effect";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FiberSet from "effect/FiberSet";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { ServerSecretStore } from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ChannelDeliveryStore } from "./ChannelDeliveryStore.ts";
import {
  type ChannelRuntimeDependencies,
  type ChannelRuntimeContext,
  type ChannelRuntimeShape,
} from "./ChannelRuntimeTypes.ts";
import {
  makeKeyedLock,
  stopChannelsForBot,
  clearChannelThreadStatuses,
  shutdownAllChannels,
  stopArchivedBotChannels,
} from "./ChannelOperations.ts";
import { runtimeKey, loadConnectionSecret } from "./ChannelSecrets.ts";
import {
  WHATSAPP_WEBHOOK_PATH,
  WHATSAPP_CONNECTION_WEBHOOK_PATH,
  handlePhoneScopedWhatsAppWebhook,
  handleBotWhatsAppWebhook,
} from "./ChannelWebhooks.ts";
import { channelBindingsForRuntime, dispatchInboundChannelMessage } from "./ChannelInbound.ts";
import {
  finishChannelTurn,
  markChannelTurnWaiting,
  sendChannelMessage,
  resolveCompletedChannelReply,
} from "./ChannelDelivery.ts";
import {
  connectChannel,
  saveChannelConnection,
  deleteChannelConnection,
  attachChannelConnection,
  disconnectChannel,
  detachChannelConnection,
  changeChannelProject,
  reconnectChannel,
  restoreConnectedChannels,
} from "./ChannelConnections.ts";

export { defaultProjectIdForBot } from "@akeru/shared/channelProject";

const makeChannelRuntime = (deps: ChannelRuntimeDependencies) =>
  Effect.gen(function* () {
    const serviceScope = yield* Scope.Scope;
    // Created before the callback set and the shutdown finalizer, so it closes last.
    const transportScope = yield* Scope.fork(serviceScope);
    const runSdkCallback = yield* FiberSet.makeRuntimePromise();

    const ctx: ChannelRuntimeContext = {
      deps,
      runtimes: new Map(),
      statuses: new WeakMap(),
      withLock: makeKeyedLock(),
      runSdkCallback,
      transportScope,
      connecting: new Set(),
      closed: false,
    };

    const shutdown = shutdownAllChannels(ctx);
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        ctx.closed = true;
      }).pipe(Effect.andThen(shutdown)),
    );

    return {
      connect: (input) => connectChannel(ctx, input),
      saveConnection: (input) => saveChannelConnection(ctx, input),
      deleteConnection: (connectionId) => deleteChannelConnection(ctx, connectionId),
      attach: (botId, connectionId, projectId, provider) =>
        attachChannelConnection(ctx, botId, connectionId, projectId, provider),
      changeProject: (botId, provider, projectId) =>
        changeChannelProject(ctx, botId, provider, projectId),
      disconnect: (botId, provider) => disconnectChannel(ctx, botId, provider),
      detach: (botId, provider) => detachChannelConnection(ctx, botId, provider),
      reconnect: (botId, provider) => reconnectChannel(ctx, botId, provider),
      restoreConnectedChannels: restoreConnectedChannels(ctx),
      dispatchInbound: (input) => dispatchInboundChannelMessage(ctx, input),
      sendChannelMessage: (input) => sendChannelMessage(ctx, input),
      finishChannelTurn: (threadId, turnId, state, requestMessageId) =>
        finishChannelTurn(ctx, threadId, turnId, state, requestMessageId),
      markChannelTurnWaiting: (threadId, turnId, waiting) =>
        markChannelTurnWaiting(ctx, threadId, turnId, waiting),
      resolveCompletedChannelReply: (threadId, turnId) =>
        resolveCompletedChannelReply(ctx, threadId, turnId),
      sendCompletedChannelReply: (threadId, turnId) =>
        resolveCompletedChannelReply(ctx, threadId, turnId).pipe(
          Effect.flatMap((target) =>
            target ? sendChannelMessage(ctx, target) : Effect.succeed(null),
          ),
        ),
      stopChannelsForBot: (botId) => stopChannelsForBot(ctx, botId),
      clearChannelThreadStatuses: (threadId) => clearChannelThreadStatuses(ctx, threadId),
      stopArchivedBotChannels: (events) => stopArchivedBotChannels(ctx, events),
      handleWhatsAppWebhook: (botId, request) => handleBotWhatsAppWebhook(ctx, botId, request),
      handleWhatsAppConnectionWebhook: (connectionId, request) =>
        ctx.deps.readModel.pipe(
          Effect.map(
            (model) =>
              model.bots.find(
                (bot) =>
                  bot.archivedAt === null &&
                  (bot.channelBindings ?? []).some(
                    (binding) =>
                      binding.provider === "whatsapp" && binding.connectionId === connectionId,
                  ),
              )?.id,
          ),
          Effect.catchCause(() => Effect.succeed(undefined)),
          Effect.flatMap((botId) =>
            botId
              ? loadConnectionSecret(ctx, connectionId).pipe(
                  Effect.flatMap((secret) =>
                    handlePhoneScopedWhatsAppWebhook(ctx, botId, secret, request),
                  ),
                  Effect.catchCause(() =>
                    Effect.succeed(new Response("Not Found", { status: 404 })),
                  ),
                )
              : Effect.succeed(new Response("Not Found", { status: 404 })),
          ),
        ),
      channelBindingsForRuntime: (bindings) =>
        channelBindingsForRuntime(
          bindings,
          (botId, provider) => {
            const runtime = ctx.runtimes.get(runtimeKey(botId, provider));

            return runtime !== undefined && (runtime.isHealthy?.() ?? true);
          },
          (botId, provider) => ctx.connecting.has(runtimeKey(botId, provider)),
        ),
      shutdown,
    } satisfies ChannelRuntimeShape;
  });

/**
 * Owns every external channel transport for one server. Transports, locks, and status
 * reactions live in the service; closing its scope stops them.
 */
export class ChannelRuntime extends Context.Service<ChannelRuntime, ChannelRuntimeShape>()(
  "akeru-bot/channels/ChannelRuntime",
) {
  /** Builds the runtime from explicit dependencies. */
  static readonly layerWith = (dependencies: ChannelRuntimeDependencies) =>
    Layer.effect(ChannelRuntime, makeChannelRuntime(dependencies));

  /**
   * Builds the runtime from server services. Channels need secret and delivery storage;
   * without them the layer provides nothing and consumers treat channels as unavailable.
   */
  static readonly layer = Layer.unwrap(
    Effect.gen(function* () {
      const secretStore = yield* Effect.serviceOption(ServerSecretStore);
      const deliveryStore = yield* Effect.serviceOption(ChannelDeliveryStore);

      if (Option.isNone(secretStore) || Option.isNone(deliveryStore)) return Layer.empty;
      const engine = yield* OrchestrationEngineService;
      const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
      const settings = yield* ServerSettingsService;
      const crypto = yield* Crypto.Crypto;
      const serverConfig = yield* Effect.serviceOption(ServerConfig.ServerConfig);
      const publicOrigin = Option.getOrUndefined(serverConfig)?.publicOrigin;

      return ChannelRuntime.layerWith({
        ...(publicOrigin ? { publicOrigin } : {}),
        engine,
        secretStore: secretStore.value,
        settings,
        deliveryStore: deliveryStore.value,
        readModel: projectionSnapshotQuery.getCommandReadModel(),
        readThread: (threadId) =>
          projectionSnapshotQuery
            .getThreadDetailById(threadId, { activityKinds: [] })
            .pipe(Effect.map(Option.getOrNull)),
        nowIso: DateTime.now.pipe(Effect.map(DateTime.formatIso)),
        randomUuid: crypto.randomUUIDv4,
      });
    }),
  );
}

/** Serves WhatsApp webhooks for the runtime in the router's context. */
export const whatsAppWebhookRouteLayer = HttpRouter.use((router) =>
  Effect.gen(function* () {
    const channelRuntime = yield* Effect.serviceOption(ChannelRuntime);

    const connectionHandler = Effect.gen(function* () {
      if (Option.isNone(channelRuntime))
        return HttpServerResponse.text("Not Found", { status: 404 });

      const params = yield* HttpRouter.schemaPathParams(
        Schema.Struct({ connectionId: ChannelConnectionId }),
      ).pipe(Effect.option);

      if (Option.isNone(params)) return HttpServerResponse.text("Not Found", { status: 404 });
      const request = yield* HttpServerRequest.HttpServerRequest;
      const webRequest = yield* HttpServerRequest.toWeb(request).pipe(Effect.option);

      if (Option.isNone(webRequest)) return HttpServerResponse.text("Bad Request", { status: 400 });

      const response = yield* channelRuntime.value.handleWhatsAppConnectionWebhook(
        params.value.connectionId,
        webRequest.value,
      );

      return HttpServerResponse.fromWeb(response);
    });

    const handler = Effect.gen(function* () {
      if (Option.isNone(channelRuntime))
        return HttpServerResponse.text("Not Found", { status: 404 });

      const params = yield* HttpRouter.schemaPathParams(Schema.Struct({ botId: BotId })).pipe(
        Effect.option,
      );

      if (Option.isNone(params)) return HttpServerResponse.text("Not Found", { status: 404 });
      const request = yield* HttpServerRequest.HttpServerRequest;
      const webRequest = yield* HttpServerRequest.toWeb(request).pipe(Effect.option);

      if (Option.isNone(webRequest)) return HttpServerResponse.text("Bad Request", { status: 400 });

      const response = yield* channelRuntime.value.handleWhatsAppWebhook(
        params.value.botId,
        webRequest.value,
      );

      return HttpServerResponse.fromWeb(response);
    });

    yield* router.add("GET", WHATSAPP_WEBHOOK_PATH, handler);
    yield* router.add("POST", WHATSAPP_WEBHOOK_PATH, handler);
    yield* router.add("GET", WHATSAPP_CONNECTION_WEBHOOK_PATH, connectionHandler);
    yield* router.add("POST", WHATSAPP_CONNECTION_WEBHOOK_PATH, connectionHandler);
  }),
);

export { ChannelPostRejectedError } from "./ChannelErrors.ts";

export { ChannelRuntimeError } from "./ChannelErrors.ts";

export { ChannelTransportError } from "./ChannelErrors.ts";

export { isChannelPostRejected } from "./ChannelErrors.ts";

export { isChannelTransportError } from "./ChannelErrors.ts";

export { channelFailureCategory } from "./ChannelErrors.ts";

export { channelFailureMessage } from "./ChannelErrors.ts";

export type { ChannelFailurePresentation } from "./ChannelErrors.ts";

export { channelFailurePresentation } from "./ChannelErrors.ts";

export type { ChannelTransportRuntime } from "./ChannelRuntimeTypes.ts";

export type { ChannelOperationError } from "./ChannelRuntimeTypes.ts";

export type { InboundChannelMessage } from "./ChannelRuntimeTypes.ts";

export type { ChannelTransportContext } from "./ChannelRuntimeTypes.ts";

export type { ChannelRuntimeDependencies } from "./ChannelRuntimeTypes.ts";

export type { ChannelReplyTarget } from "./ChannelRuntimeTypes.ts";

export type { ChannelRestoreFailure } from "./ChannelRuntimeTypes.ts";

export { makeKeyedLock } from "./ChannelOperations.ts";

export { channelReplyTextWithFooter } from "./ChannelDelivery.ts";

export { CHANNEL_SENT_MESSAGE_RECOVERY_LIMIT } from "./ChannelDelivery.ts";

export { CHANNEL_MENTION_CONTEXT_LIMIT } from "./ChannelInbound.ts";

export { CHANNEL_MENTION_CONTEXT_CHARACTER_LIMIT } from "./ChannelInbound.ts";

export { CHANNEL_GATEWAY_RENEWAL_INTERVAL } from "./ChannelTransportFactory.ts";

export { channelThreadId } from "./ChannelInbound.ts";

export { WHATSAPP_WEBHOOK_PATH } from "./ChannelWebhooks.ts";

export { WHATSAPP_CONNECTION_WEBHOOK_PATH } from "./ChannelWebhooks.ts";

export { WHATSAPP_NOT_LIVE_MESSAGE } from "./ChannelDelivery.ts";

export { whatsAppWebhookUrl } from "./ChannelWebhooks.ts";

export { mentionWithContext } from "./ChannelInbound.ts";

export { channelBindingsForRuntime } from "./ChannelInbound.ts";

export { ignoredInbound } from "./ChannelTransportFactory.ts";

export type { RenewingGateway } from "./ChannelTransportFactory.ts";

export { startRenewingGateway } from "./ChannelTransportFactory.ts";

export type { ChannelRuntimeShape } from "./ChannelRuntimeTypes.ts";
