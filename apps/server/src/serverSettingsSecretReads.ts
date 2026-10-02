import { ProviderInstanceId } from "@akeru/contracts";
import {
  type CloudSandboxProvider,
  CLOUD_SANDBOX_PROVIDERS,
  type ProviderInstanceConfig,
  type ProviderInstanceEnvironmentVariable,
  type SandboxProviderConnection,
  SANDBOX_PROVIDER_CREDENTIALS,
  ServerSettings,
  ServerSettingsError,
} from "@akeru/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as ServerSecretStore from "./auth/ServerSecretStore.ts";

import {
  textDecoder,
  BROWSERBASE_API_KEY_SECRET,
  providerEnvironmentSecretName,
  sandboxEnvironmentSecretName,
} from "./serverSettingsSecretNames.ts";

export const createSettingsSecretReads = (
  secretStore: ServerSecretStore.ServerSecretStore["Service"],
  settingsPath: string,
) => {
  const materializeProviderEnvironmentSecrets = (
    settings: ServerSettings,
  ): Effect.Effect<ServerSettings, ServerSettingsError> =>
    Effect.gen(function* () {
      const providerInstances: Record<ProviderInstanceId, ProviderInstanceConfig> = {
        ...settings.providerInstances,
      };

      for (const [instanceId, instance] of Object.entries(settings.providerInstances)) {
        if (!instance.environment) continue;
        const environment: ProviderInstanceEnvironmentVariable[] = [];

        for (const variable of instance.environment) {
          if (!variable.sensitive || !variable.valueRedacted) {
            environment.push(variable);
            continue;
          }

          const secret = yield* secretStore
            .get(providerEnvironmentSecretName({ instanceId, name: variable.name }))
            .pipe(
              Effect.mapError(
                (cause) =>
                  new ServerSettingsError({
                    settingsPath,
                    operation: "read-secret",
                    providerInstanceId: instanceId,
                    environmentVariable: variable.name,
                    cause,
                  }),
              ),
            );

          environment.push({
            ...variable,
            value: Option.isSome(secret) ? textDecoder.decode(secret.value) : "",
          });
        }

        providerInstances[ProviderInstanceId.make(instanceId)] = {
          ...instance,
          environment,
        } satisfies ProviderInstanceConfig;
      }

      return {
        ...settings,
        providerInstances,
      };
    });

  const materializeSandboxEnvironmentSecrets = (
    settings: ServerSettings,
  ): Effect.Effect<ServerSettings, ServerSettingsError> =>
    Effect.gen(function* () {
      const providers = { ...settings.sandbox.providers };

      for (const provider of CLOUD_SANDBOX_PROVIDERS) {
        const environment: ProviderInstanceEnvironmentVariable[] = [];

        for (const variable of settings.sandbox.providers[provider].environment) {
          if (!variable.sensitive || !variable.valueRedacted) {
            environment.push(variable);
            continue;
          }

          const secret = yield* secretStore
            .get(sandboxEnvironmentSecretName({ provider, name: variable.name }))
            .pipe(
              Effect.mapError(
                (cause) =>
                  new ServerSettingsError({
                    settingsPath,
                    operation: "read-secret",
                    providerInstanceId: `sandbox:${provider}`,
                    environmentVariable: variable.name,
                    cause,
                  }),
              ),
            );

          environment.push({
            ...variable,
            value: Option.isSome(secret) ? textDecoder.decode(secret.value) : "",
          });
        }

        providers[provider] = { environment } satisfies SandboxProviderConnection;
      }

      return {
        ...settings,
        sandbox: { ...settings.sandbox, providers },
      };
    });

  const materializeBrowserProviderSecret = (
    settings: ServerSettings,
  ): Effect.Effect<ServerSettings, ServerSettingsError> => {
    if (!settings.browserProvider.browserbaseApiKeyRedacted) return Effect.succeed(settings);

    return secretStore.get(BROWSERBASE_API_KEY_SECRET).pipe(
      Effect.mapError(
        (cause) =>
          new ServerSettingsError({
            settingsPath,
            operation: "read-secret",
            providerInstanceId: "browser:browserbase",
            environmentVariable: "BROWSERBASE_API_KEY",
            cause,
          }),
      ),
      Effect.map((secret) => ({
        ...settings,
        browserProvider: {
          ...settings.browserProvider,
          browserbaseApiKey: Option.isSome(secret) ? textDecoder.decode(secret.value) : "",
        },
      })),
    );
  };

  const sandboxValidationError = (
    provider: CloudSandboxProvider,
    environmentVariable: string,
    cause: string,
  ) =>
    new ServerSettingsError({
      settingsPath,
      operation: "validate-sandbox",
      providerInstanceId: `sandbox:${provider}`,
      environmentVariable,
      cause: new Error(cause),
    });

  const validatePersistedSandboxSecrets = (settings: ServerSettings) =>
    Effect.gen(function* () {
      for (const provider of CLOUD_SANDBOX_PROVIDERS) {
        const variables = settings.sandbox.providers[provider].environment;

        for (const credential of SANDBOX_PROVIDER_CREDENTIALS[provider]) {
          if (!credential.sensitive) continue;

          const hasInvalidMarker = variables.some(
            (variable) =>
              variable.name === credential.name &&
              (variable.sensitive !== true ||
                variable.valueRedacted !== true ||
                variable.value.length > 0),
          );

          if (!hasInvalidMarker) continue;

          return yield* sandboxValidationError(
            provider,
            credential.name,
            "Persisted sandbox secrets must use a redacted secret-store marker.",
          );
        }
      }
    });

  const validateSandboxSettings = (settings: ServerSettings) =>
    Effect.gen(function* () {
      for (const provider of CLOUD_SANDBOX_PROVIDERS) {
        const environment = settings.sandbox.providers[provider].environment;
        const credentials = SANDBOX_PROVIDER_CREDENTIALS[provider];

        for (const credential of credentials) {
          if (
            credential.sensitive &&
            environment.some(
              (variable) => variable.name === credential.name && variable.sensitive !== true,
            )
          ) {
            return yield* sandboxValidationError(
              provider,
              credential.name,
              "Sandbox secret credentials must be marked sensitive.",
            );
          }
        }

        if (environment.length === 0 && settings.sandbox.defaultProvider !== provider) continue;
        const values = new Map(environment.map((variable) => [variable.name, variable.value]));

        for (const credential of credentials) {
          if ((values.get(credential.name) ?? "").trim().length > 0) continue;

          return yield* sandboxValidationError(
            provider,
            credential.name,
            "The sandbox provider is missing a required credential.",
          );
        }
      }
    });

  const materializeAllSecrets = (settings: ServerSettings) =>
    materializeProviderEnvironmentSecrets(settings).pipe(
      Effect.flatMap(materializeSandboxEnvironmentSecrets),
      Effect.flatMap(materializeBrowserProviderSecret),
    );

  return {
    materializeProviderEnvironmentSecrets,
    materializeSandboxEnvironmentSecrets,
    materializeBrowserProviderSecret,
    sandboxValidationError,
    validatePersistedSandboxSecrets,
    validateSandboxSettings,
    materializeAllSecrets,
  };
};
