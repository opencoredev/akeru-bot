import type * as RpcGroup from "effect/unstable/rpc/RpcGroup";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { type DiscoveredLocalServerList, ProviderUploadFeedbackError, type ServerSelfUpdateError, type ServerSelfUpdateProgressEvent, isProviderAvailable, RpcClientId, WS_METHODS, WsRpcGroup } from "@akeru/contracts";
import * as ServerSettings from "./serverSettings.ts";

import { PROVIDER_STATUS_DEBOUNCE_MS, PROVIDER_SUBSCRIBE_REFRESH_TTL_MS } from "./wsSupport.ts";
import type { WsConnection } from "./wsConnection.ts";

export const createWsServerHandlers = ({ currentSessionId, keybindings, portDiscovery, agentController, providerRegistry, providerMaintenanceRunner, serverSelfUpdate, subscriptionAuth, serverSettings, backgroundPolicy, rpcClientIds, observeRpcEffect, observeRpcStream, observeRpcStreamEffect, loadServerConfig, providerRefreshes }: Pick<WsConnection, "currentSessionId" | "keybindings" | "portDiscovery" | "agentController" | "providerRegistry" | "providerMaintenanceRunner" | "serverSelfUpdate" | "subscriptionAuth" | "serverSettings" | "backgroundPolicy" | "rpcClientIds" | "observeRpcEffect" | "observeRpcStream" | "observeRpcStreamEffect" | "loadServerConfig" | "providerRefreshes">) => ({

        [WS_METHODS.serverProbe]: (_input) =>
          observeRpcEffect(WS_METHODS.serverProbe, Effect.succeed({}), {
            "rpc.aggregate": "server",
          }),

        [WS_METHODS.serverGetConfig]: (_input) =>
          observeRpcEffect(WS_METHODS.serverGetConfig, loadServerConfig, {
            "rpc.aggregate": "server",
          }),

        [WS_METHODS.serverRefreshProviders]: (input) =>
          observeRpcEffect(
            WS_METHODS.serverRefreshProviders,
            (input.instanceId !== undefined
              ? providerRegistry.refreshInstance(input.instanceId)
              : providerRegistry.refresh()
            ).pipe(Effect.map((providers) => ({ providers }))),
            { "rpc.aggregate": "server" },
          ),

        [WS_METHODS.providerUploadFeedback]: (input) =>
          observeRpcEffect(
            WS_METHODS.providerUploadFeedback,
            agentController.uploadFeedback(input).pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderUploadFeedbackError({
                    threadId: input.threadId,
                    cause,
                  }),
              ),
            ),
            { "rpc.aggregate": "provider" },
          ),

        [WS_METHODS.serverUpdateProvider]: (input) =>
          observeRpcEffect(
            WS_METHODS.serverUpdateProvider,
            providerMaintenanceRunner.updateProvider(input),
            {
              "rpc.aggregate": "server",
            },
          ),

        [WS_METHODS.serverUpdateServer]: (input) =>
          observeRpcEffect(WS_METHODS.serverUpdateServer, serverSelfUpdate.update(input), {
            "rpc.aggregate": "server",
          }),

        [WS_METHODS.serverUpdateServerWithProgress]: (input) =>
          observeRpcStream(
            WS_METHODS.serverUpdateServerWithProgress,
            Stream.callback<ServerSelfUpdateProgressEvent, ServerSelfUpdateError>((queue) =>
              serverSelfUpdate
                .update(input, (stage) =>
                  Queue.offer(queue, {
                    type: "progress",
                    stage,
                  }).pipe(Effect.asVoid),
                )
                .pipe(
                  Effect.flatMap((result) =>
                    Queue.offer(queue, {
                      type: "complete",
                      result,
                    }),
                  ),
                  Effect.catchTags({
                    ServerSelfUpdateError: (error) => Queue.fail(queue, error),
                  }),
                  Effect.andThen(Queue.end(queue)),
                  Effect.forkScoped,
                ),
            ),
            { "rpc.aggregate": "server" },
          ),

        [WS_METHODS.serverUpsertKeybinding]: (rule) =>
          observeRpcEffect(
            WS_METHODS.serverUpsertKeybinding,
            Effect.gen(function* () {
              const keybindingsConfig = yield* keybindings.upsertKeybindingRule(rule);
              return { keybindings: keybindingsConfig, issues: [] };
            }),
            { "rpc.aggregate": "server" },
          ),

        [WS_METHODS.serverRemoveKeybinding]: (rule) =>
          observeRpcEffect(
            WS_METHODS.serverRemoveKeybinding,
            Effect.gen(function* () {
              const keybindingsConfig = yield* keybindings.removeKeybindingRule(rule);
              return { keybindings: keybindingsConfig, issues: [] };
            }),
            { "rpc.aggregate": "server" },
          ),

        [WS_METHODS.serverGetSettings]: (_input) =>
          observeRpcEffect(
            WS_METHODS.serverGetSettings,
            serverSettings.getSettings.pipe(
              Effect.map(ServerSettings.redactServerSettingsForClient),
            ),
            {
              "rpc.aggregate": "server",
            },
          ),

        [WS_METHODS.serverUpdateSettings]: ({ patch }) =>
          observeRpcEffect(
            WS_METHODS.serverUpdateSettings,
            Effect.gen(function* () {
              const current = patch.providerInstances
                ? yield* serverSettings.getSettings
                : undefined;
              const updated = yield* serverSettings.updateSettings(patch);
              if (patch.providerInstances && current) {
                yield* Effect.promise(() =>
                  subscriptionAuth.pruneDeletedInstanceCredentials(
                    current.providerInstances,
                    updated.providerInstances,
                  ),
                );
              }
              return ServerSettings.redactServerSettingsForClient(updated);
            }),
            {
              "rpc.aggregate": "server",
            },
          ),

        [WS_METHODS.serverReportClientActivity]: (input, metadata) =>
          Ref.update(rpcClientIds, (clientIds) => {
            const next = new Set(clientIds);
            next.add(RpcClientId.make(metadata.client.id));
            return next;
          }).pipe(
            Effect.andThen(
              observeRpcEffect(
                WS_METHODS.serverReportClientActivity,
                backgroundPolicy.reportClientActivity(
                  currentSessionId,
                  RpcClientId.make(metadata.client.id),
                  input,
                ),
                { "rpc.aggregate": "server" },
              ),
            ),
          ),

        [WS_METHODS.subscribeDiscoveredLocalServers]: (input) =>
          observeRpcStream(
            WS_METHODS.subscribeDiscoveredLocalServers,
            Stream.callback<DiscoveredLocalServerList>((queue) =>
              Effect.gen(function* () {
                const configuredUrls = input.configuredUrls ?? [];
                yield* portDiscovery.retain;
                const initial = yield* portDiscovery.scan(configuredUrls);
                const initialScannedAt = DateTime.formatIso(yield* DateTime.now);
                yield* Queue.offer(queue, {
                  servers: initial,
                  scannedAt: initialScannedAt,
                  configuredUrlProbing: true,
                });
                yield* portDiscovery.subscribe(
                  { configuredUrls, initialSnapshot: initial },
                  (servers) =>
                    Effect.gen(function* () {
                      const scannedAt = DateTime.formatIso(yield* DateTime.now);
                      yield* Queue.offer(queue, {
                        servers,
                        scannedAt,
                        configuredUrlProbing: true,
                      });
                    }),
                );
              }),
            ),
            { "rpc.aggregate": "preview" },
          ),

        [WS_METHODS.subscribeServerConfig]: (_input) =>
          observeRpcStreamEffect(
            WS_METHODS.subscribeServerConfig,
            Effect.gen(function* () {
              const keybindingsUpdates = keybindings.streamChanges.pipe(
                Stream.map((event) => ({
                  version: 1 as const,
                  type: "keybindingsUpdated" as const,
                  payload: {
                    keybindings: event.keybindings,
                    issues: event.issues,
                  },
                })),
              );
              const providerStatuses = providerRegistry.streamChanges.pipe(
                Stream.map((providers) => ({
                  version: 1 as const,
                  type: "providerStatuses" as const,
                  payload: { providers },
                })),
                Stream.debounce(Duration.millis(PROVIDER_STATUS_DEBOUNCE_MS)),
              );
              const settingsUpdates = serverSettings.streamChanges.pipe(
                Stream.map((settings) => ServerSettings.redactServerSettingsForClient(settings)),
                Stream.map((settings) => ({
                  version: 1 as const,
                  type: "settingsUpdated" as const,
                  payload: { settings },
                })),
              );

              // Serve the cached provider list. Re-probe only instances whose
              // last check is older than the TTL and that no other
              // subscription is already probing, so reconnect bursts and
              // additional clients do not spawn repeated CLI version checks.
              // Unavailable instances have no driver to probe, so their
              // `checkedAt` never moves and they are skipped.
              const nowMs = yield* Clock.currentTimeMillis;
              const staleProviders = (yield* providerRegistry.getProviders).filter(
                (provider) =>
                  isProviderAvailable(provider) &&
                  !providerRefreshes.inFlight.has(provider.instanceId) &&
                  nowMs - Date.parse(provider.checkedAt) >= PROVIDER_SUBSCRIBE_REFRESH_TTL_MS,
              );
              for (const provider of staleProviders) {
                providerRefreshes.inFlight.add(provider.instanceId);
              }
              if (staleProviders.length > 0) {
                yield* Effect.forEach(
                  staleProviders,
                  (provider) =>
                    providerRegistry
                      .refreshInstance(provider.instanceId)
                      .pipe(
                        Effect.ensuring(
                          Effect.sync(() => providerRefreshes.inFlight.delete(provider.instanceId)),
                        ),
                      ),
                  { concurrency: "unbounded", discard: true },
                ).pipe(Effect.ignoreCause({ log: true }), Effect.forkIn(providerRefreshes.scope));
              }

              const liveUpdates = Stream.merge(
                keybindingsUpdates,
                Stream.merge(providerStatuses, settingsUpdates),
              );

              return Stream.concat(
                Stream.make({
                  version: 1 as const,
                  type: "snapshot" as const,
                  config: yield* loadServerConfig,
                }),
                liveUpdates,
              );
            }),
            { "rpc.aggregate": "server" },
          )
} satisfies Pick<RpcGroup.HandlersFrom<RpcGroup.Rpcs<typeof WsRpcGroup>>, typeof WS_METHODS.serverProbe | typeof WS_METHODS.serverGetConfig | typeof WS_METHODS.serverRefreshProviders | typeof WS_METHODS.providerUploadFeedback | typeof WS_METHODS.serverUpdateProvider | typeof WS_METHODS.serverUpdateServer | typeof WS_METHODS.serverUpdateServerWithProgress | typeof WS_METHODS.serverUpsertKeybinding | typeof WS_METHODS.serverRemoveKeybinding | typeof WS_METHODS.serverGetSettings | typeof WS_METHODS.serverUpdateSettings | typeof WS_METHODS.serverReportClientActivity | typeof WS_METHODS.subscribeDiscoveredLocalServers | typeof WS_METHODS.subscribeServerConfig>);
