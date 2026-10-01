import type * as RpcGroup from "effect/unstable/rpc/RpcGroup";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import { WS_METHODS, WsRpcGroup } from "@akeru/contracts";
import { decideCommandSequence } from "./orchestration/decider.ts";
import * as Portability from "./portability.ts";

import { nowIso, portabilityError, availablePortabilityProviderIds, validatePortabilityProjectFolders } from "./wsSupport.ts";
import type { WsConnection } from "./wsConnection.ts";

export const createWsPortabilityHandlers = ({ crypto, projectionSnapshotQuery, dispatchFromClient, providerRegistry, serverSettings, observeRpcEffect }: Pick<WsConnection, "crypto" | "projectionSnapshotQuery" | "dispatchFromClient" | "providerRegistry" | "serverSettings" | "observeRpcEffect">) => ({

        [WS_METHODS.portabilityExport]: (_input) =>
          observeRpcEffect(
            WS_METHODS.portabilityExport,
            Effect.gen(function* () {
              const [snapshot, settings, exportedAt] = yield* Effect.all([
                projectionSnapshotQuery.getSnapshot(),
                serverSettings.getSettings,
                nowIso,
              ]);
              return yield* Effect.try({
                try: () => {
                  const archive = Portability.createPortabilityArchive(
                    snapshot,
                    settings,
                    exportedAt,
                  );
                  return {
                    filename: `akeru-${exportedAt.slice(0, 10)}.akeru.archive`,
                    contents: Portability.serializePortabilityArchive(archive),
                  };
                },
                catch: (cause) => portabilityError("export", cause),
              });
            }).pipe(Effect.mapError((cause) => portabilityError("export", cause))),
            { "rpc.aggregate": "portability" },
          ),

        [WS_METHODS.portabilityPreviewImport]: ({ contents, projectFolders = {} }) =>
          observeRpcEffect(
            WS_METHODS.portabilityPreviewImport,
            Effect.gen(function* () {
              const archive = yield* Effect.try({
                try: () => Portability.parsePortabilityArchive(contents),
                catch: (cause) => portabilityError("preview", cause),
              });
              const [snapshot, settings, providers] = yield* Effect.all([
                projectionSnapshotQuery.getSnapshot(),
                serverSettings.getSettings,
                providerRegistry.getProviders,
              ]);
              const validatedProjectFolders = yield* validatePortabilityProjectFolders(
                archive,
                snapshot,
                projectFolders,
                "preview",
              );
              return Portability.previewPortabilityImport(
                archive,
                snapshot,
                settings,
                availablePortabilityProviderIds(providers),
                validatedProjectFolders,
              );
            }).pipe(Effect.mapError((cause) => portabilityError("preview", cause))),
            { "rpc.aggregate": "portability" },
          ),

        [WS_METHODS.portabilityApplyImport]: ({
          contents,
          projectFolders = {},
          expectedSnapshotSequence,
          expectedStateChecksum,
        }) =>
          observeRpcEffect(
            WS_METHODS.portabilityApplyImport,
            Effect.gen(function* () {
              const archive = yield* Effect.try({
                try: () => Portability.parsePortabilityArchive(contents),
                catch: (cause) => portabilityError("apply", cause),
              });
              const [snapshot, settings, providers] = yield* Effect.all([
                projectionSnapshotQuery.getSnapshot(),
                serverSettings.getSettings,
                providerRegistry.getProviders,
              ]);
              const availableProviderIds = availablePortabilityProviderIds(providers);
              const validatedProjectFolders = yield* validatePortabilityProjectFolders(
                archive,
                snapshot,
                projectFolders,
                "apply",
              );
              if (
                !Portability.isPortabilityPreviewCurrent(
                  snapshot,
                  settings,
                  availableProviderIds,
                  {
                    snapshotSequence: expectedSnapshotSequence,
                    stateChecksum: expectedStateChecksum,
                  },
                  validatedProjectFolders,
                )
              ) {
                return yield* portabilityError(
                  "apply",
                  new Error("Akeru state changed after the preview. Review the archive again."),
                );
              }
              const plan = Portability.commandsForPortabilityImport(
                archive,
                snapshot,
                settings,
                availableProviderIds,
                validatedProjectFolders,
              );
              yield* decideCommandSequence({ commands: plan.commands, readModel: snapshot }).pipe(
                Effect.provideService(Crypto.Crypto, crypto),
              );
              const outcomes = yield* Effect.forEach(
                plan.commands,
                (command, index) =>
                  dispatchFromClient(command).pipe(
                    Effect.match({
                      onFailure: (cause) => ({
                        item: plan.commandItems[index]!,
                        succeeded: false,
                        message: cause.message,
                      }),
                      onSuccess: () => ({
                        item: plan.commandItems[index]!,
                        succeeded: true,
                      }),
                    }),
                  ),
                { concurrency: 1 },
              );
              if (plan.settingsPatch && plan.settingsItem) {
                outcomes.push(
                  yield* serverSettings.updateSettings(plan.settingsPatch).pipe(
                    Effect.match({
                      onFailure: (cause) => ({
                        item: plan.settingsItem!,
                        succeeded: false,
                        message: cause.message,
                      }),
                      onSuccess: () => ({
                        item: plan.settingsItem!,
                        succeeded: true,
                      }),
                    }),
                  ),
                );
              }
              return Portability.summarizePortabilityApply(outcomes, plan.skipped);
            }).pipe(Effect.mapError((cause) => portabilityError("apply", cause))),
            { "rpc.aggregate": "portability" },
          )
} satisfies Pick<RpcGroup.HandlersFrom<RpcGroup.Rpcs<typeof WsRpcGroup>>, typeof WS_METHODS.portabilityExport | typeof WS_METHODS.portabilityPreviewImport | typeof WS_METHODS.portabilityApplyImport>);
