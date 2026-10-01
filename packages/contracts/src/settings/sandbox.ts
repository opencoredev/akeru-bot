import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { TrimmedString } from "../baseSchemas.ts";
import { BotSandbox } from "../orchestration/roster.ts";
import { ProviderInstanceEnvironmentVariable } from "../providerInstance.ts";

export const SandboxProvider = BotSandbox;

export type SandboxProvider = BotSandbox;

export type CloudSandboxProvider = Exclude<SandboxProvider, "local">;

export const CLOUD_SANDBOX_PROVIDERS = [
  "e2b",
  "daytona",
  "vercel",
  "upstash",
  "ascii",
  "railway",
  "tenki",
] as const;

export const SANDBOX_PROVIDER_CREDENTIALS = {
  e2b: [{ name: "E2B_API_KEY", sensitive: true }],
  daytona: [{ name: "DAYTONA_API_KEY", sensitive: true }],
  vercel: [
    { name: "VERCEL_TOKEN", sensitive: true },
    { name: "VERCEL_TEAM_ID", sensitive: false },
    { name: "VERCEL_PROJECT_ID", sensitive: false },
  ],
  upstash: [{ name: "UPSTASH_BOX_API_KEY", sensitive: true }],
  ascii: [{ name: "BOX_API_KEY", sensitive: true }],
  railway: [
    { name: "RAILWAY_API_TOKEN", sensitive: true },
    { name: "RAILWAY_ENVIRONMENT_ID", sensitive: false },
  ],
  tenki: [{ name: "TENKI_API_KEY", sensitive: true }],
} as const satisfies Readonly<
  Record<
    CloudSandboxProvider,
    ReadonlyArray<{ readonly name: string; readonly sensitive: boolean }>
  >
>;

export const SandboxProviderConnection = Schema.Struct({
  environment: Schema.Array(ProviderInstanceEnvironmentVariable).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
}).pipe(Schema.withDecodingDefault(Effect.succeed({})));

export type SandboxProviderConnection = typeof SandboxProviderConnection.Type;

export const SandboxSettings = Schema.Struct({
  defaultProvider: SandboxProvider.pipe(
    Schema.withDecodingDefault(Effect.succeed("local" as const)),
  ),
  autoIdle: Schema.Literal(true).pipe(Schema.withDecodingDefault(Effect.succeed(true as const))),
  providers: Schema.Struct({
    e2b: SandboxProviderConnection,
    daytona: SandboxProviderConnection,
    vercel: SandboxProviderConnection,
    upstash: SandboxProviderConnection,
    ascii: SandboxProviderConnection,
    railway: SandboxProviderConnection,
    tenki: SandboxProviderConnection,
  }).pipe(Schema.withDecodingDefault(Effect.succeed({}))),
}).pipe(Schema.withDecodingDefault(Effect.succeed({})));

export type SandboxSettings = typeof SandboxSettings.Type;

export const BrowserProviderSettings = Schema.Struct({
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  browserbaseApiKey: TrimmedString.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  browserbaseApiKeyRedacted: Schema.optionalKey(Schema.Boolean),
}).pipe(Schema.withDecodingDefault(Effect.succeed({})));

export type BrowserProviderSettings = typeof BrowserProviderSettings.Type;

const SandboxProviderConnectionPatch = Schema.Struct({
  environment: Schema.optionalKey(Schema.Array(ProviderInstanceEnvironmentVariable)),
});

export const SandboxSettingsPatch = Schema.Struct({
  defaultProvider: Schema.optionalKey(SandboxProvider),
  autoIdle: Schema.optionalKey(Schema.Literal(true)),
  providers: Schema.optionalKey(
    Schema.Struct({
      e2b: Schema.optionalKey(SandboxProviderConnectionPatch),
      daytona: Schema.optionalKey(SandboxProviderConnectionPatch),
      vercel: Schema.optionalKey(SandboxProviderConnectionPatch),
      upstash: Schema.optionalKey(SandboxProviderConnectionPatch),
      ascii: Schema.optionalKey(SandboxProviderConnectionPatch),
      railway: Schema.optionalKey(SandboxProviderConnectionPatch),
      tenki: Schema.optionalKey(SandboxProviderConnectionPatch),
    }),
  ),
});
