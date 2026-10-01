import { CLOUD_SANDBOX_PROVIDERS, type ProviderInstanceConfig, type ProviderInstanceEnvironmentVariable, ProviderInstanceId, type SandboxProviderConnection, ServerSettings, ServerSettingsError } from "@akeru/contracts";
import * as Effect from "effect/Effect";
import * as ServerSecretStore from "./auth/ServerSecretStore.ts";

import { textEncoder, BROWSERBASE_API_KEY_SECRET, providerEnvironmentSecretName, sandboxEnvironmentSecretName, redactProviderEnvironmentVariable } from "./serverSettingsSecretNames.ts";
export const createSettingsSecretWrites = (secretStore: ServerSecretStore.ServerSecretStore["Service"], settingsPath: string) => {


  const persistProviderEnvironmentSecrets = (
    current: ServerSettings,
    next: ServerSettings,
  ): Effect.Effect<ServerSettings, ServerSettingsError> =>
    Effect.gen(function* () {
      const providerInstances: Record<ProviderInstanceId, ProviderInstanceConfig> = {
        ...next.providerInstances,
      };

      const nextSecretKeys = new Set<string>();
      for (const [instanceId, instance] of Object.entries(next.providerInstances)) {
        if (!instance.environment) continue;
        const environment: ProviderInstanceEnvironmentVariable[] = [];
        for (const variable of instance.environment) {
          const secretName = providerEnvironmentSecretName({ instanceId, name: variable.name });
          if (!variable.sensitive) {
            yield* secretStore.remove(secretName).pipe(
              Effect.mapError(
                (cause) =>
                  new ServerSettingsError({
                    settingsPath,
                    operation: "remove-secret",
                    providerInstanceId: instanceId,
                    environmentVariable: variable.name,
                    cause,
                  }),
              ),
            );
            environment.push(redactProviderEnvironmentVariable(variable));
            continue;
          }

          nextSecretKeys.add(secretName);
          // Match the provider environment's last-value-wins behavior for duplicate names.
          const previous = variable.valueRedacted
            ? current.providerInstances[ProviderInstanceId.make(instanceId)]?.environment?.findLast(
                (entry) => entry.name === variable.name,
              )
            : undefined;
          const inlineValue =
            previous?.sensitive && !previous.valueRedacted && previous.value.length > 0
              ? previous.value
              : undefined;
          const value = inlineValue ?? variable.value;
          if (!variable.valueRedacted || inlineValue !== undefined) {
            if (value.length > 0) {
              yield* secretStore.set(secretName, textEncoder.encode(value)).pipe(
                Effect.mapError(
                  (cause) =>
                    new ServerSettingsError({
                      settingsPath,
                      operation: "write-secret",
                      providerInstanceId: instanceId,
                      environmentVariable: variable.name,
                      cause,
                    }),
                ),
              );
              environment.push({ ...variable, value: "", valueRedacted: true });
            } else {
              yield* secretStore.remove(secretName).pipe(
                Effect.mapError(
                  (cause) =>
                    new ServerSettingsError({
                      settingsPath,
                      operation: "remove-secret",
                      providerInstanceId: instanceId,
                      environmentVariable: variable.name,
                      cause,
                    }),
                ),
              );
              const { valueRedacted: _omit, ...rest } = variable;
              environment.push(rest);
            }
            continue;
          }

          environment.push(redactProviderEnvironmentVariable(variable));
        }
        providerInstances[ProviderInstanceId.make(instanceId)] = {
          ...instance,
          environment,
        } satisfies ProviderInstanceConfig;
      }

      for (const [instanceId, instance] of Object.entries(current.providerInstances)) {
        for (const variable of instance.environment ?? []) {
          if (!variable.sensitive) continue;
          const secretName = providerEnvironmentSecretName({ instanceId, name: variable.name });
          if (nextSecretKeys.has(secretName)) continue;
          yield* secretStore.remove(secretName).pipe(
            Effect.mapError(
              (cause) =>
                new ServerSettingsError({
                  settingsPath,
                  operation: "remove-stale-secret",
                  providerInstanceId: instanceId,
                  environmentVariable: variable.name,
                  cause,
                }),
            ),
          );
        }
      }

      return {
        ...next,
        providerInstances,
      };
    });


  const persistSandboxEnvironmentSecrets = (
    current: ServerSettings,
    next: ServerSettings,
  ): Effect.Effect<ServerSettings, ServerSettingsError> =>
    Effect.gen(function* () {
      const providers = { ...next.sandbox.providers };
      const nextSecretKeys = new Set<string>();

      for (const provider of CLOUD_SANDBOX_PROVIDERS) {
        const environment: ProviderInstanceEnvironmentVariable[] = [];
        for (const variable of next.sandbox.providers[provider].environment) {
          const secretName = sandboxEnvironmentSecretName({ provider, name: variable.name });
          if (!variable.sensitive) {
            yield* secretStore.remove(secretName).pipe(
              Effect.mapError(
                (cause) =>
                  new ServerSettingsError({
                    settingsPath,
                    operation: "remove-secret",
                    providerInstanceId: `sandbox:${provider}`,
                    environmentVariable: variable.name,
                    cause,
                  }),
              ),
            );
            environment.push(redactProviderEnvironmentVariable(variable));
            continue;
          }

          nextSecretKeys.add(secretName);
          if (!variable.valueRedacted) {
            if (variable.value.length > 0) {
              yield* secretStore.set(secretName, textEncoder.encode(variable.value)).pipe(
                Effect.mapError(
                  (cause) =>
                    new ServerSettingsError({
                      settingsPath,
                      operation: "write-secret",
                      providerInstanceId: `sandbox:${provider}`,
                      environmentVariable: variable.name,
                      cause,
                    }),
                ),
              );
              environment.push({ ...variable, value: "", valueRedacted: true });
            } else {
              yield* secretStore.remove(secretName).pipe(
                Effect.mapError(
                  (cause) =>
                    new ServerSettingsError({
                      settingsPath,
                      operation: "remove-secret",
                      providerInstanceId: `sandbox:${provider}`,
                      environmentVariable: variable.name,
                      cause,
                    }),
                ),
              );
              const { valueRedacted: _omit, ...rest } = variable;
              environment.push(rest);
            }
            continue;
          }

          environment.push(redactProviderEnvironmentVariable(variable));
        }
        providers[provider] = { environment } satisfies SandboxProviderConnection;
      }

      for (const provider of CLOUD_SANDBOX_PROVIDERS) {
        for (const variable of current.sandbox.providers[provider].environment) {
          if (!variable.sensitive) continue;
          const secretName = sandboxEnvironmentSecretName({ provider, name: variable.name });
          if (nextSecretKeys.has(secretName)) continue;
          yield* secretStore.remove(secretName).pipe(
            Effect.mapError(
              (cause) =>
                new ServerSettingsError({
                  settingsPath,
                  operation: "remove-stale-secret",
                  providerInstanceId: `sandbox:${provider}`,
                  environmentVariable: variable.name,
                  cause,
                }),
            ),
          );
        }
      }

      return {
        ...next,
        sandbox: { ...next.sandbox, providers },
      };
    });


  const persistBrowserProviderSecret = (
    next: ServerSettings,
  ): Effect.Effect<ServerSettings, ServerSettingsError> => {
    const browserProvider = next.browserProvider;
    if (browserProvider.browserbaseApiKeyRedacted) return Effect.succeed(next);
    const persist = browserProvider.browserbaseApiKey
      ? secretStore.set(
          BROWSERBASE_API_KEY_SECRET,
          textEncoder.encode(browserProvider.browserbaseApiKey),
        )
      : secretStore.remove(BROWSERBASE_API_KEY_SECRET);
    return persist.pipe(
      Effect.mapError(
        (cause) =>
          new ServerSettingsError({
            settingsPath,
            operation: browserProvider.browserbaseApiKey ? "write-secret" : "remove-secret",
            providerInstanceId: "browser:browserbase",
            environmentVariable: "BROWSERBASE_API_KEY",
            cause,
          }),
      ),
      Effect.map(() => {
        const { browserbaseApiKeyRedacted: _redacted, ...browserProviderWithoutRedaction } =
          browserProvider;
        return {
          ...next,
          browserProvider: {
            ...browserProviderWithoutRedaction,
            browserbaseApiKey: "",
            ...(browserProvider.browserbaseApiKey ? { browserbaseApiKeyRedacted: true } : {}),
          },
        };
      }),
    );
  };
return { persistProviderEnvironmentSecrets, persistSandboxEnvironmentSecrets, persistBrowserProviderSecret };
};
