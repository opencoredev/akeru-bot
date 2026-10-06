import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { type OrchestrationClientOrigin, WsRpcGroup } from "@akeru/contracts";
import { HttpRouter, HttpServerRequest, HttpServerRespondable } from "effect/unstable/http";
import { RpcSerialization, RpcServer } from "effect/unstable/rpc";
import * as OrchestrationEngine from "./orchestration/Services/OrchestrationEngine.ts";
import * as ProviderMaintenanceRunner from "./provider/providerMaintenanceRunner.ts";
import * as ServerSelfUpdate from "./cloud/selfUpdate.ts";
import * as PreviewAutomationBroker from "./mcp/PreviewAutomationBroker.ts";
import * as EnvironmentAuth from "./auth/EnvironmentAuth.ts";
import * as VoiceCallManager from "./voiceCall/VoiceCallManager.ts";
import * as SessionStore from "./auth/SessionStore.ts";
import { failEnvironmentAuthInvalid, failEnvironmentInternal } from "./auth/http.ts";

import { createWsCloudHandlers } from "./wsCloudHandlers.ts";
import { createWsConnection } from "./wsConnection.ts";
import { createWsOrchestrationHandlers } from "./wsOrchestrationHandlers.ts";
import { createWsOrchestrationSubscriptions } from "./wsOrchestrationSubscriptions.ts";
import { createWsServerHandlers } from "./wsServerHandlers.ts";
import { createWsAuthHandlers } from "./wsAuthHandlers.ts";
import { createWsPortabilityHandlers } from "./wsPortabilityHandlers.ts";
import { createWsBotServicesHandlers } from "./wsBotServicesHandlers.ts";
import { createWsToolHandlers } from "./wsToolHandlers.ts";
import { createWsDiagnosticHandlers } from "./wsDiagnosticHandlers.ts";
import { createWsMemoryHandlers } from "./wsMemoryHandlers.ts";
import { createWsWorkspaceHandlers } from "./wsWorkspaceHandlers.ts";
import { type ProviderSubscribeRefreshes, readClientConnectionOrigin } from "./wsSupport.ts";

export {
  isThreadDetailEvent,
  resolveAvailableEditorsForConfig,
  resolveFileManagerRevealKindForConfig,
} from "./wsSupport.ts";

const createWsRpcLayer = (
  currentSession: EnvironmentAuth.AuthenticatedSession,
  clientOrigin: OrchestrationClientOrigin,
  previewAutomationBroker: PreviewAutomationBroker.PreviewAutomationBroker["Service"],
  voiceCalls: VoiceCallManager.VoiceCallManager["Service"],
  providerRefreshes: ProviderSubscribeRefreshes,
) =>
  WsRpcGroup.toLayer(
    Effect.gen(function* () {
      const connection = yield* createWsConnection(
        currentSession,
        clientOrigin,
        previewAutomationBroker,
        voiceCalls,
        providerRefreshes,
      );

      return {
        ...createWsOrchestrationHandlers(connection),
        ...createWsOrchestrationSubscriptions(connection),
        ...createWsServerHandlers(connection),
        ...createWsCloudHandlers(connection),
        ...createWsAuthHandlers(connection),
        ...createWsPortabilityHandlers(connection),
        ...createWsBotServicesHandlers(connection),
        ...createWsToolHandlers(connection),
        ...createWsDiagnosticHandlers(connection),
        ...createWsMemoryHandlers(connection),
        ...createWsWorkspaceHandlers(connection),
      };
    }),
  );

export const websocketRpcRouteLayer = Layer.unwrap(
  Effect.gen(function* () {
    const previewAutomationBroker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
    const voiceCalls = yield* VoiceCallManager.VoiceCallManager;
    const orchestrationEngine = yield* OrchestrationEngine.OrchestrationEngineService;
    // Deleting a bot frees the single call slot it may hold.
    yield* Effect.forkScoped(
      VoiceCallManager.hangupDeletedBotCalls(voiceCalls, orchestrationEngine.streamDomainEvents),
    );
    const serverSelfUpdate = yield* ServerSelfUpdate.ServerSelfUpdate;

    const providerRefreshes: ProviderSubscribeRefreshes = {
      inFlight: new Set(),
      scope: yield* Effect.scope,
    };

    return HttpRouter.add(
      "GET",
      "/ws",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
        const sessions = yield* SessionStore.SessionStore;

        const session = yield* serverAuth.authenticateWebSocketUpgrade(request).pipe(
          Effect.catchIf(EnvironmentAuth.isServerAuthCredentialError, (error) =>
            failEnvironmentAuthInvalid(EnvironmentAuth.serverAuthCredentialReason(error)),
          ),
          Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, (error) =>
            failEnvironmentInternal("internal_error", error),
          ),
        );

        const clientOrigin = readClientConnectionOrigin(request);
        yield* sessions.recordClientConnection(session.sessionId, clientOrigin);

        const rpcWebSocketHttpEffect = yield* RpcServer.toHttpEffectWebsocket(WsRpcGroup, {
          disableTracing: true,
        }).pipe(
          Effect.provide(
            createWsRpcLayer(
              session,
              clientOrigin,
              previewAutomationBroker,
              voiceCalls,
              providerRefreshes,
            ).pipe(
              Layer.provideMerge(RpcSerialization.layerJson),
              Layer.provide(ProviderMaintenanceRunner.layer),
              Layer.provide(Layer.succeed(ServerSelfUpdate.ServerSelfUpdate, serverSelfUpdate)),
            ),
          ),
        );

        return yield* Effect.acquireUseRelease(
          sessions.markConnected(session.sessionId),
          () => rpcWebSocketHttpEffect,
          () => sessions.markDisconnected(session.sessionId),
        );
      }).pipe(
        Effect.catchTags({
          EnvironmentAuthInvalidError: HttpServerRespondable.toResponse,
          EnvironmentInternalError: HttpServerRespondable.toResponse,
        }),
      ),
    );
  }),
).pipe(Layer.provide(VoiceCallManager.layer()));
