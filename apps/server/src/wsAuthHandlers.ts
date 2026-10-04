import { accountScope } from "./subscription-auth/service.ts";
import type * as RpcGroup from "effect/unstable/rpc/RpcGroup";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import {
  type AuthAccessStreamEvent,
  McpServerAuthenticationError,
  ImageGenerationError,
  SubscriptionAuthError,
  WS_METHODS,
  WsRpcGroup,
} from "@akeru/contracts";
import { runImageProviderHealthTest } from "./image-generation/service.ts";
import * as PairingGrantStore from "./auth/PairingGrantStore.ts";
import * as SessionStore from "./auth/SessionStore.ts";

import { isMcpServerAuthenticationError, toAuthAccessStreamEvent } from "./wsSupport.ts";
import type { WsConnection } from "./wsConnection.ts";

export const createWsAuthHandlers = ({
  currentSessionId,
  projectionSnapshotQuery,
  agentController,
  subscriptionAuth,
  refreshChangedSubscriptionProviders,
  resetChangedApiKeySessions,
  validateAccountInstance,
  composio,
  bootstrapCredentials,
  sessions,
  getAccessHealthSnapshot,
  getImageProviderSnapshot,
  observeRpcEffect,
  observeRpcStream,
  observeRpcStreamEffect,
  loadAuthAccessSnapshot,
}: Pick<
  WsConnection,
  | "currentSessionId"
  | "projectionSnapshotQuery"
  | "agentController"
  | "subscriptionAuth"
  | "refreshChangedSubscriptionProviders"
  | "resetChangedApiKeySessions"
  | "validateAccountInstance"
  | "composio"
  | "bootstrapCredentials"
  | "sessions"
  | "getAccessHealthSnapshot"
  | "getImageProviderSnapshot"
  | "observeRpcEffect"
  | "observeRpcStream"
  | "observeRpcStreamEffect"
  | "loadAuthAccessSnapshot"
>) =>
  ({
    [WS_METHODS.composioGetStatus]: (_input) =>
      observeRpcEffect(WS_METHODS.composioGetStatus, composio.getStatus, {
        "rpc.aggregate": "composio",
      }),

    [WS_METHODS.composioConfigure]: ({ apiKey }) =>
      observeRpcEffect(WS_METHODS.composioConfigure, composio.configure(apiKey), {
        "rpc.aggregate": "composio",
      }),

    [WS_METHODS.composioRemove]: (_input) =>
      observeRpcEffect(WS_METHODS.composioRemove, composio.remove, {
        "rpc.aggregate": "composio",
      }),

    [WS_METHODS.composioSearchToolkits]: (input) =>
      observeRpcEffect(WS_METHODS.composioSearchToolkits, composio.searchToolkits(input), {
        "rpc.aggregate": "composio",
      }),

    [WS_METHODS.composioAuthorize]: (input) =>
      observeRpcEffect(WS_METHODS.composioAuthorize, composio.authorize(input), {
        "rpc.aggregate": "composio",
      }),

    [WS_METHODS.composioDisconnect]: ({ connectionId }) =>
      observeRpcEffect(WS_METHODS.composioDisconnect, composio.disconnect(connectionId), {
        "rpc.aggregate": "composio",
      }),

    [WS_METHODS.subscriptionAuthList]: (_input) =>
      observeRpcEffect(WS_METHODS.subscriptionAuthList, getAccessHealthSnapshot(), {
        "rpc.aggregate": "server",
      }),

    [WS_METHODS.mcpServerAuthenticate]: ({ mcpServerId }) =>
      observeRpcStream(
        WS_METHODS.mcpServerAuthenticate,
        Stream.callback((queue) =>
          Effect.gen(function* () {
            const snapshot = yield* projectionSnapshotQuery.getShellSnapshot();

            const server = snapshot.mcpServers?.find((candidate) => candidate.id === mcpServerId);

            if (!server) {
              return yield* new McpServerAuthenticationError({
                mcpServerId,
                reason: "The MCP server does not exist.",
              });
            }

            if (!server.enabled) {
              return yield* new McpServerAuthenticationError({
                mcpServerId,
                reason: "Enable the MCP server before authentication.",
              });
            }

            if (server.transport === "stdio") {
              return yield* new McpServerAuthenticationError({
                mcpServerId,
                reason: "Local MCP servers do not support OAuth authentication.",
              });
            }

            const result = yield* agentController.authenticateMcpServer({
              server,
              onAuthorizationUrl: (authorizationUrl) => {
                Queue.offerUnsafe(queue, {
                  type: "authorization-required",
                  authorizationUrl,
                });
              },
            });

            yield* Queue.offer(queue, {
              type: "connected",
              toolCount: result.toolCount,
              recoveryFailures: result.recoveryFailures,
            });
          }).pipe(
            Effect.mapError((cause) =>
              isMcpServerAuthenticationError(cause)
                ? cause
                : new McpServerAuthenticationError({
                    mcpServerId,
                    reason: cause instanceof Error ? cause.message : String(cause),
                  }),
            ),
            Effect.catchTag("McpServerAuthenticationError", (error) => Queue.fail(queue, error)),
            Effect.andThen(Queue.end(queue)),
            Effect.forkScoped,
          ),
        ),
        { "rpc.aggregate": "provider" },
      ),

    [WS_METHODS.subscriptionAuthStart]: ({ provider, ...options }) =>
      observeRpcEffect(
        WS_METHODS.subscriptionAuthStart,
        Effect.gen(function* () {
          yield* validateAccountInstance(provider, options.instanceId);

          return yield* Effect.tryPromise({
            try: () => subscriptionAuth.startLogin(provider, options),
            catch: (cause) =>
              new SubscriptionAuthError({
                reason: cause instanceof Error ? cause.message : String(cause),
              }),
          });
        }),
        { "rpc.aggregate": "server" },
      ),

    [WS_METHODS.subscriptionAuthPoll]: ({ loginId }) =>
      observeRpcEffect(
        WS_METHODS.subscriptionAuthPoll,
        Effect.tryPromise({
          try: () => subscriptionAuth.pollLogin(loginId),
          catch: (cause) =>
            new SubscriptionAuthError({
              reason: cause instanceof Error ? cause.message : String(cause),
            }),
        }).pipe(refreshChangedSubscriptionProviders, resetChangedApiKeySessions),
        { "rpc.aggregate": "server" },
      ),

    [WS_METHODS.subscriptionAuthComplete]: ({ loginId, code }) =>
      observeRpcEffect(
        WS_METHODS.subscriptionAuthComplete,
        Effect.tryPromise({
          try: () => subscriptionAuth.completeLogin(loginId, code),
          catch: (cause) =>
            new SubscriptionAuthError({
              reason: cause instanceof Error ? cause.message : String(cause),
            }),
        }).pipe(refreshChangedSubscriptionProviders, resetChangedApiKeySessions),
        { "rpc.aggregate": "server" },
      ),

    [WS_METHODS.subscriptionAuthCancel]: ({ loginId }) =>
      observeRpcEffect(
        WS_METHODS.subscriptionAuthCancel,
        Effect.sync(() => {
          subscriptionAuth.cancelLogin(loginId);

          return {};
        }),
        { "rpc.aggregate": "server" },
      ),

    [WS_METHODS.subscriptionAuthLogout]: ({ provider, instanceId, accountId }) =>
      observeRpcEffect(
        WS_METHODS.subscriptionAuthLogout,
        Effect.tryPromise({
          try: () =>
            subscriptionAuth.logout(provider, accountId ? accountScope(accountId) : instanceId),
          catch: (cause) =>
            new SubscriptionAuthError({
              reason: cause instanceof Error ? cause.message : String(cause),
            }),
        }).pipe(
          refreshChangedSubscriptionProviders,
          resetChangedApiKeySessions,
          Effect.andThen(getAccessHealthSnapshot()),
        ),
        { "rpc.aggregate": "server" },
      ),

    [WS_METHODS.subscriptionAuthHealthTest]: ({ provider, instanceId, accountId }) =>
      observeRpcEffect(
        WS_METHODS.subscriptionAuthHealthTest,
        Effect.tryPromise({
          try: () =>
            subscriptionAuth.testHealth(provider, accountId ? accountScope(accountId) : instanceId),
          catch: (cause) =>
            new SubscriptionAuthError({
              reason: cause instanceof Error ? cause.message : String(cause),
            }),
        }).pipe(Effect.andThen(getAccessHealthSnapshot())),
        { "rpc.aggregate": "server" },
      ),

    [WS_METHODS.subscriptionAuthSetAccountOrder]: ({ provider, accountIds }) =>
      observeRpcEffect(
        WS_METHODS.subscriptionAuthSetAccountOrder,
        Effect.tryPromise({
          try: () => subscriptionAuth.setAccountOrder(provider, accountIds),
          catch: (cause) =>
            new SubscriptionAuthError({
              reason: cause instanceof Error ? cause.message : String(cause),
            }),
        }).pipe(Effect.andThen(getAccessHealthSnapshot())),
        { "rpc.aggregate": "server" },
      ),

    [WS_METHODS.imageProviderList]: (_input) =>
      observeRpcEffect(WS_METHODS.imageProviderList, getImageProviderSnapshot(), {
        "rpc.aggregate": "server",
      }),

    [WS_METHODS.imageProviderHealthTest]: ({ provider }) =>
      observeRpcEffect(
        WS_METHODS.imageProviderHealthTest,
        Effect.tryPromise({
          try: () => runImageProviderHealthTest({ provider, subscriptionAuth }),
          catch: (cause) =>
            new ImageGenerationError({
              reason: cause instanceof Error ? cause.message : String(cause),
            }),
        }).pipe(Effect.andThen(getImageProviderSnapshot())),
        { "rpc.aggregate": "server" },
      ),

    [WS_METHODS.subscribeAuthAccess]: (_input) =>
      observeRpcStreamEffect(
        WS_METHODS.subscribeAuthAccess,
        Effect.gen(function* () {
          const initialSnapshot = yield* loadAuthAccessSnapshot();
          const revisionRef = yield* Ref.make(1);

          const accessChanges: Stream.Stream<
            PairingGrantStore.BootstrapCredentialChange | SessionStore.SessionCredentialChange
          > = Stream.merge(bootstrapCredentials.streamChanges, sessions.streamChanges);

          const liveEvents: Stream.Stream<AuthAccessStreamEvent> = accessChanges.pipe(
            Stream.mapEffect((change) =>
              Ref.updateAndGet(revisionRef, (revision) => revision + 1).pipe(
                Effect.map((revision) =>
                  toAuthAccessStreamEvent(change, revision, currentSessionId),
                ),
              ),
            ),
          );

          return Stream.concat(
            Stream.make({
              version: 1 as const,
              revision: 1,
              type: "snapshot" as const,
              payload: initialSnapshot,
            }),
            liveEvents,
          );
        }),
        { "rpc.aggregate": "auth" },
      ),
  }) satisfies Pick<
    RpcGroup.HandlersFrom<RpcGroup.Rpcs<typeof WsRpcGroup>>,
    | typeof WS_METHODS.composioGetStatus
    | typeof WS_METHODS.composioConfigure
    | typeof WS_METHODS.composioRemove
    | typeof WS_METHODS.composioSearchToolkits
    | typeof WS_METHODS.composioAuthorize
    | typeof WS_METHODS.composioDisconnect
    | typeof WS_METHODS.subscriptionAuthList
    | typeof WS_METHODS.mcpServerAuthenticate
    | typeof WS_METHODS.subscriptionAuthStart
    | typeof WS_METHODS.subscriptionAuthPoll
    | typeof WS_METHODS.subscriptionAuthComplete
    | typeof WS_METHODS.subscriptionAuthCancel
    | typeof WS_METHODS.subscriptionAuthLogout
    | typeof WS_METHODS.subscriptionAuthSetAccountOrder
    | typeof WS_METHODS.subscriptionAuthHealthTest
    | typeof WS_METHODS.imageProviderList
    | typeof WS_METHODS.imageProviderHealthTest
    | typeof WS_METHODS.subscribeAuthAccess
  >;
