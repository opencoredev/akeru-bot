import { CLOUD_SANDBOX_PROVIDERS, ServerSettings, ServerSettingsError } from "@akeru/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as ServerSecretStore from "./auth/ServerSecretStore.ts";

import { BROWSERBASE_API_KEY_SECRET, providerEnvironmentSecretName, sandboxEnvironmentSecretName } from "./serverSettingsSecretNames.ts";
export const createSettingsSecretRollback = (secretStore: ServerSecretStore.ServerSecretStore["Service"], settingsPath: string) => {


  type SecretSnapshot = {
    readonly name: string;
    readonly previous: Option.Option<Uint8Array>;
    readonly providerInstanceId: string;
    readonly environmentVariable: string;
  };


  const snapshotSettingsSecrets = (current: ServerSettings, next: ServerSettings) =>
    Effect.gen(function* () {
      const references = new Map<
        string,
        Pick<SecretSnapshot, "providerInstanceId" | "environmentVariable">
      >();
      for (const settings of [current, next]) {
        for (const [instanceId, instance] of Object.entries(settings.providerInstances)) {
          for (const variable of instance.environment ?? []) {
            references.set(providerEnvironmentSecretName({ instanceId, name: variable.name }), {
              providerInstanceId: instanceId,
              environmentVariable: variable.name,
            });
          }
        }
        for (const provider of CLOUD_SANDBOX_PROVIDERS) {
          for (const variable of settings.sandbox.providers[provider].environment) {
            references.set(sandboxEnvironmentSecretName({ provider, name: variable.name }), {
              providerInstanceId: `sandbox:${provider}`,
              environmentVariable: variable.name,
            });
          }
        }
      }
      references.set(BROWSERBASE_API_KEY_SECRET, {
        providerInstanceId: "browser:browserbase",
        environmentVariable: "BROWSERBASE_API_KEY",
      });

      const snapshots: SecretSnapshot[] = [];
      for (const [name, reference] of references) {
        const previous = yield* secretStore.get(name).pipe(
          Effect.mapError(
            (cause) =>
              new ServerSettingsError({
                settingsPath,
                operation: "read-secret",
                ...reference,
                cause,
              }),
          ),
        );
        snapshots.push({ name, previous, ...reference });
      }
      return snapshots;
    });


  const rollbackSettingsSecrets = (snapshots: ReadonlyArray<SecretSnapshot>) =>
    Effect.gen(function* () {
      let firstFailure: ServerSettingsError | undefined;
      for (const snapshot of snapshots.toReversed()) {
        const restore = Option.match(snapshot.previous, {
          onNone: () => secretStore.remove(snapshot.name),
          onSome: (value) => secretStore.set(snapshot.name, value),
        }).pipe(
          Effect.mapError(
            (cause) =>
              new ServerSettingsError({
                settingsPath,
                operation: "rollback-secret",
                providerInstanceId: snapshot.providerInstanceId,
                environmentVariable: snapshot.environmentVariable,
                cause,
              }),
          ),
        );
        yield* restore.pipe(
          Effect.catch((error) => {
            firstFailure ??= error;
            return Effect.void;
          }),
        );
      }
      if (firstFailure) return yield* firstFailure;
    });
return { snapshotSettingsSecrets, rollbackSettingsSecrets };
};
