import {
  type CloudSandboxProvider,
  type ProviderInstanceEnvironmentVariable,
  type SandboxProviderConnection,
  ServerSettings,
} from "@akeru/contracts";

export const textEncoder = new TextEncoder();

export const textDecoder = new TextDecoder();

export const BROWSERBASE_API_KEY_SECRET = "browser-provider-browserbase-api-key";

export function providerEnvironmentSecretName(input: {
  readonly instanceId: string;
  readonly name: string;
}): string {
  return `provider-env-${Buffer.from(input.instanceId, "utf8").toString("base64url")}-${Buffer.from(input.name, "utf8").toString("base64url")}`;
}

export function sandboxEnvironmentSecretName(input: {
  readonly provider: CloudSandboxProvider;
  readonly name: string;
}): string {
  return `sandbox-env-${input.provider}-${Buffer.from(input.name, "utf8").toString("base64url")}`;
}

export function redactProviderEnvironmentVariable(
  variable: ProviderInstanceEnvironmentVariable,
): ProviderInstanceEnvironmentVariable {
  if (!variable.sensitive) {
    const { valueRedacted: _omit, ...rest } = variable;

    return rest;
  }

  return {
    ...variable,
    value: "",
    ...(variable.value.length > 0 || variable.valueRedacted ? { valueRedacted: true } : {}),
  };
}

export function redactSandboxProviderConnection(
  connection: SandboxProviderConnection,
): SandboxProviderConnection {
  return {
    environment: connection.environment.map(redactProviderEnvironmentVariable),
  };
}

export function redactServerSettingsForClient(settings: ServerSettings): ServerSettings {
  const providerInstances = Object.fromEntries(
    Object.entries(settings.providerInstances).map(([instanceId, instance]) => [
      instanceId,
      instance.environment
        ? {
            ...instance,
            environment: instance.environment.map(redactProviderEnvironmentVariable),
          }
        : instance,
    ]),
  );

  const browserProvider = settings.browserProvider;

  return {
    ...settings,
    providerInstances,
    sandbox: {
      ...settings.sandbox,
      providers: {
        e2b: redactSandboxProviderConnection(settings.sandbox.providers.e2b),
        daytona: redactSandboxProviderConnection(settings.sandbox.providers.daytona),
        vercel: redactSandboxProviderConnection(settings.sandbox.providers.vercel),
        upstash: redactSandboxProviderConnection(settings.sandbox.providers.upstash),
        ascii: redactSandboxProviderConnection(settings.sandbox.providers.ascii),
        railway: redactSandboxProviderConnection(settings.sandbox.providers.railway),
        tenki: redactSandboxProviderConnection(settings.sandbox.providers.tenki),
      },
    },
    browserProvider: {
      ...browserProvider,
      browserbaseApiKey: "",
      ...(browserProvider.browserbaseApiKey.length > 0 || browserProvider.browserbaseApiKeyRedacted
        ? { browserbaseApiKeyRedacted: true }
        : {}),
    },
  };
}
