import { providerInstanceConfigEnabledFlag } from "./providers.ts";
import type { ProviderDriverKind } from "../providerInstance.ts";
import * as Effect from "effect/Effect";
import * as Duration from "effect/Duration";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";
import { ChannelConnectionId, TrimmedNonEmptyString, TrimmedString } from "../baseSchemas.ts";
import { ThreadEnvMode } from "../environment.ts";
import {
  DEFAULT_TEXT_GENERATION_MODEL,
  DEFAULT_TEXT_GENERATION_REASONING_EFFORT,
  ProviderOptionSelections,
} from "../model.ts";
import {
  BotSandboxBrowserSharing,
  DEFAULT_BOT_SANDBOX_BROWSER_SHARING,
  ChannelProvider,
} from "../orchestration/roster.ts";
import {
  DEFAULT_LOCAL_EXECUTION_MODE,
  LocalExecutionMode,
  ModelSelection,
} from "../orchestration/modelSelection.ts";
import {
  VoiceProvider,
  ChatGptRealtimeVoice,
  VoiceSettings,
  VoiceApiProvider,
  VoiceTranscriptionProvider,
  VoiceSynthesisVoices,
} from "../voiceCall.ts";
import { ImageGenerationSettings, ImageGenerationSettingsPatch } from "../imageGeneration.ts";
import { ProviderInstanceConfig, ProviderInstanceId } from "../providerInstance.ts";
import { DEFAULT_PRODUCT_FEEDBACK_ENDPOINT, ProductFeedbackEndpoint } from "./client.ts";
import {
  CodexSettings,
  ClaudeSettings,
  GrokSettings,
  KimiSettings,
  OpenCodeGoSettings,
  OpenCodeSettings,
  CodexSettingsPatch,
  ClaudeSettingsPatch,
  GrokSettingsPatch,
  KimiSettingsPatch,
  OpenCodeGoSettingsPatch,
  OpenCodeSettingsPatch,
} from "./providers.ts";
import { SandboxSettings, BrowserProviderSettings, SandboxSettingsPatch } from "./sandbox.ts";
import { MemorySettings, MemorySettingsPatch } from "./memory.ts";

export const ObservabilitySettings = Schema.Struct({
  otlpTracesUrl: TrimmedString.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  otlpMetricsUrl: TrimmedString.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
});

export type ObservabilitySettings = typeof ObservabilitySettings.Type;

export const SourceControlWritingStyleMode = Schema.Literals([
  "repo_conventions",
  "conventional_commits",
  "custom",
]);

export type SourceControlWritingStyleMode = typeof SourceControlWritingStyleMode.Type;

export const SourceControlWritingStyleSettings = Schema.Struct({
  mode: SourceControlWritingStyleMode.pipe(
    Schema.withDecodingDefault(Effect.succeed("repo_conventions" as const)),
  ),
  customInstructions: TrimmedString.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  followChangeRequestTemplates: Schema.Boolean.pipe(
    Schema.withDecodingDefault(Effect.succeed(true)),
  ),
});

export type SourceControlWritingStyleSettings = typeof SourceControlWritingStyleSettings.Type;

export const DEFAULT_AUTOMATIC_GIT_FETCH_INTERVAL = Duration.seconds(30);

export const DEFAULT_PROVIDER_HEALTH_REFRESH_INTERVAL = Duration.minutes(5);

export const BackgroundActivityProfile = Schema.Literals([
  "balanced",
  "performance",
  "battery-saver",
]);

export type BackgroundActivityProfile = typeof BackgroundActivityProfile.Type;

export const DEFAULT_BACKGROUND_ACTIVITY_PROFILE: BackgroundActivityProfile = "balanced";

export const BackgroundActivityProfileSelection = Schema.Literals([
  "balanced",
  "performance",
  "battery-saver",
  "custom",
]);

export type BackgroundActivityProfileSelection = typeof BackgroundActivityProfileSelection.Type;

export const BackgroundActivityOverrides = Schema.Struct({
  automaticGitFetchInterval: Schema.optionalKey(Schema.DurationFromMillis),
  providerHealthRefreshInterval: Schema.optionalKey(Schema.DurationFromMillis),
  hostPowerMonitorActiveInterval: Schema.optionalKey(Schema.DurationFromMillis),
  hostPowerMonitorIdleInterval: Schema.optionalKey(Schema.DurationFromMillis),
  idleClientTtl: Schema.optionalKey(Schema.DurationFromMillis),
  pauseWhenHostLocked: Schema.optionalKey(Schema.Boolean),
  pauseWhenHostLowPower: Schema.optionalKey(Schema.Boolean),
  pauseWhenClientLowPower: Schema.optionalKey(Schema.Boolean),
  pauseWhenOnBattery: Schema.optionalKey(Schema.Boolean),
});

export type BackgroundActivityOverrides = typeof BackgroundActivityOverrides.Type;

export const BackgroundActivitySettings = Schema.Struct({
  schemaVersion: Schema.Literal(1).pipe(Schema.withDecodingDefault(Effect.succeed(1 as const))),
  profile: BackgroundActivityProfileSelection.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_BACKGROUND_ACTIVITY_PROFILE)),
  ),
  baseProfile: Schema.optionalKey(BackgroundActivityProfile),
  overrides: BackgroundActivityOverrides.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
}).pipe(Schema.withDecodingDefault(Effect.succeed({})));

export type BackgroundActivitySettings = typeof BackgroundActivitySettings.Type;

export const ChannelConnectionProfile = Schema.Struct({
  id: ChannelConnectionId,
  provider: ChannelProvider,
  adapter: Schema.Literals(["telegram", "photon", "whatsapp", "slack", "discord"]),
  name: TrimmedNonEmptyString,
  externalIdentity: Schema.optional(TrimmedNonEmptyString),
  managementUrl: Schema.optional(TrimmedNonEmptyString),
  /** Server-built inbound webhook URL for providers that push events (WhatsApp). */
  webhookUrl: Schema.optional(TrimmedNonEmptyString),
});

export type ChannelConnectionProfile = typeof ChannelConnectionProfile.Type;

export const ServerSettings = Schema.Struct({
  // Legacy token-by-token assistant output. Deliberately a fresh key (was
  // `enableAssistantStreaming`): decoding drops the old key, so everyone,
  // including prior opt-ins, resets to the buffered default.
  enableLegacyTokenStreaming: Schema.Boolean.pipe(
    Schema.withDecodingDefault(Effect.succeed(false)),
  ),
  enableProviderUpdateChecks: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  analyticsEnabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  productFeedbackEnabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  productFeedbackEndpoint: ProductFeedbackEndpoint.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_PRODUCT_FEEDBACK_ENDPOINT)),
  ),
  botSandboxBrowserSharing: BotSandboxBrowserSharing.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_BOT_SANDBOX_BROWSER_SHARING)),
  ),
  localExecutionMode: LocalExecutionMode.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_LOCAL_EXECUTION_MODE)),
  ),
  /**
   * Whether agents may drive the in-app preview browser. Turning this off
   * withholds the MCP credential, so the `akeru` server (and with it every
   * `preview_*` tool) is never attached to a provider session, and the prompt
   * text describing those tools is dropped along with them. The user's own
   * browser panel is unaffected — this gates agent access only.
   *
   * Server-authoritative rather than client-local: tool injection and prompt
   * construction both happen on the server, and the answer must not differ
   * between a desktop window and a phone attached to the same server.
   */
  enableAgentBrowserAccess: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  browserProvider: BrowserProviderSettings,
  voice: VoiceSettings,
  imageGeneration: ImageGenerationSettings,
  backgroundActivity: BackgroundActivitySettings,
  // Legacy flat fields retained for old settings files and old clients. New
  // consumers should resolve `backgroundActivity` instead.
  automaticGitFetchInterval: Schema.DurationFromMillis.pipe(
    Schema.withDecodingDefault(
      Effect.succeed(Duration.toMillis(DEFAULT_AUTOMATIC_GIT_FETCH_INTERVAL)),
    ),
  ),
  providerHealthRefreshInterval: Schema.DurationFromMillis.pipe(
    Schema.withDecodingDefault(
      Effect.succeed(Duration.toMillis(DEFAULT_PROVIDER_HEALTH_REFRESH_INTERVAL)),
    ),
  ),
  backgroundActivityProfile: BackgroundActivityProfile.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_BACKGROUND_ACTIVITY_PROFILE)),
  ),
  defaultThreadEnvMode: ThreadEnvMode.pipe(
    Schema.withDecodingDefault(Effect.succeed("local" as const satisfies ThreadEnvMode)),
  ),
  newWorktreesStartFromOrigin: Schema.Boolean.pipe(
    Schema.withDecodingDefault(Effect.succeed(true)),
  ),
  addProjectBaseDirectory: TrimmedString.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  textGenerationModelSelection: ModelSelection.pipe(
    Schema.withDecodingDefault(
      Effect.succeed({
        instanceId: ProviderInstanceId.make("codex"),
        model: DEFAULT_TEXT_GENERATION_MODEL,
        options: [
          {
            id: "reasoningEffort",
            value: DEFAULT_TEXT_GENERATION_REASONING_EFFORT,
          },
        ],
      }),
    ),
  ),
  sourceControlWritingStyle: SourceControlWritingStyleSettings.pipe(
    Schema.withDecodingDefault(Effect.succeed({})),
  ),
  sourceControlWriterModelSelection: Schema.NullOr(ModelSelection).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),

  // Legacy single-instance-per-driver settings. Continues to be the source
  // of truth until `providerInstances` (below) lands per-driver migration
  // shims and the server starts hydrating instances from it. Driver-specific
  // schemas live here for the duration of the migration; once each driver
  // owns its config in its own package, this struct shrinks to nothing and
  // is removed entirely.
  providers: Schema.Struct({
    codex: CodexSettings.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
    claudeAgent: ClaudeSettings.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
    grok: GrokSettings.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
    kimi: KimiSettings.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
    opencode: OpenCodeSettings.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
    opencodeGo: OpenCodeGoSettings.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
  }).pipe(Schema.withDecodingDefault(Effect.succeed({}))),
  // New driver-agnostic instance map. Keyed by `ProviderInstanceId`; values
  // are `ProviderInstanceConfig` envelopes. The driver-specific config blob
  // is `Schema.Unknown` at this layer so envelopes with unknown drivers
  // (forks, downgrades, in-flight PR branches) round-trip without loss.
  // See providerInstance.ts for the forward/backward compatibility invariant.
  providerInstances: Schema.Record(ProviderInstanceId, ProviderInstanceConfig).pipe(
    Schema.withDecodingDefault(Effect.succeed({})),
  ),
  channelConnections: Schema.Array(ChannelConnectionProfile).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  sandbox: SandboxSettings,
  observability: ObservabilitySettings.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
  memory: MemorySettings,
});

export type ServerSettings = typeof ServerSettings.Type;

export const DEFAULT_SERVER_SETTINGS: ServerSettings = Schema.decodeSync(ServerSettings)({});

export const ServerSettingsOperation = Schema.Literals([
  "normalize",
  "check-exists",
  "read-file",
  "read-provider-history",
  "read-secret",
  "remove-secret",
  "remove-stale-secret",
  "remove-analytics-state",
  "rollback-secret",
  "write-secret",
  "validate-sandbox",
  "write-file",
  "prepare-directory",
]);

export type ServerSettingsOperation = typeof ServerSettingsOperation.Type;

export class ServerSettingsError extends Schema.TaggedErrorClass<ServerSettingsError>()(
  "ServerSettingsError",
  {
    settingsPath: Schema.String,
    operation: ServerSettingsOperation,
    providerInstanceId: Schema.optional(Schema.String),
    environmentVariable: Schema.optional(Schema.String),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    const provider =
      this.providerInstanceId === undefined ? "" : ` for provider ${this.providerInstanceId}`;

    const variable =
      this.environmentVariable === undefined
        ? ""
        : ` and environment variable ${this.environmentVariable}`;

    return `Server settings ${this.operation} failed${provider}${variable} at ${this.settingsPath}.`;
  }
}

// ── Server Settings Patch (replace with a Schema.deepPartial if available) ──────────────────────────────────────────

const ModelSelectionPatch = Schema.Struct({
  instanceId: Schema.optionalKey(ProviderInstanceId),
  model: Schema.optionalKey(TrimmedNonEmptyString),
  options: Schema.optionalKey(ProviderOptionSelections),
});

const ServerSettingsPatchFields = {
  // Server settings
  enableLegacyTokenStreaming: Schema.optionalKey(Schema.Boolean),
  enableProviderUpdateChecks: Schema.optionalKey(Schema.Boolean),
  analyticsEnabled: Schema.optionalKey(Schema.Boolean),
  localExecutionMode: Schema.optionalKey(LocalExecutionMode),
  productFeedbackEnabled: Schema.optionalKey(Schema.Boolean),
  productFeedbackEndpoint: Schema.optionalKey(ProductFeedbackEndpoint),
  botSandboxBrowserSharing: Schema.optionalKey(BotSandboxBrowserSharing),
  enableAgentBrowserAccess: Schema.optionalKey(Schema.Boolean),
  browserProvider: Schema.optionalKey(
    Schema.Struct({
      enabled: Schema.optionalKey(Schema.Boolean),
      browserbaseApiKey: Schema.optionalKey(TrimmedString),
      browserbaseApiKeyRedacted: Schema.optionalKey(Schema.Boolean),
    }),
  ),
  voice: Schema.optionalKey(
    Schema.Struct({
      enabled: Schema.optionalKey(Schema.Boolean),
      provider: Schema.optionalKey(VoiceProvider),
      voice: Schema.optionalKey(ChatGptRealtimeVoice),
      openaiVoice: Schema.optionalKey(ChatGptRealtimeVoice),
      transcriptionProvider: Schema.optionalKey(VoiceTranscriptionProvider),
      synthesisProvider: Schema.optionalKey(VoiceApiProvider),
      synthesisVoices: Schema.optionalKey(VoiceSynthesisVoices),
    }),
  ),
  imageGeneration: Schema.optionalKey(ImageGenerationSettingsPatch),
  backgroundActivity: Schema.optionalKey(
    Schema.Struct({
      schemaVersion: Schema.optionalKey(Schema.Literal(1)),
      profile: Schema.optionalKey(BackgroundActivityProfileSelection),
      baseProfile: Schema.optionalKey(BackgroundActivityProfile),
      overrides: Schema.optionalKey(BackgroundActivityOverrides),
    }),
  ),
  automaticGitFetchInterval: Schema.optionalKey(Schema.DurationFromMillis),
  providerHealthRefreshInterval: Schema.optionalKey(Schema.DurationFromMillis),
  backgroundActivityProfile: Schema.optionalKey(BackgroundActivityProfile),
  defaultThreadEnvMode: Schema.optionalKey(ThreadEnvMode),
  newWorktreesStartFromOrigin: Schema.optionalKey(Schema.Boolean),
  addProjectBaseDirectory: Schema.optionalKey(TrimmedString),
  textGenerationModelSelection: Schema.optionalKey(ModelSelectionPatch),
  sourceControlWritingStyle: Schema.optionalKey(
    Schema.Struct({
      mode: Schema.optionalKey(SourceControlWritingStyleMode),
      customInstructions: Schema.optionalKey(TrimmedString),
      followChangeRequestTemplates: Schema.optionalKey(Schema.Boolean),
    }),
  ),
  sourceControlWriterModelSelection: Schema.optionalKey(Schema.NullOr(ModelSelection)),
  sandbox: Schema.optionalKey(SandboxSettingsPatch),
  memory: Schema.optionalKey(MemorySettingsPatch),
  observability: Schema.optionalKey(
    Schema.Struct({
      otlpTracesUrl: Schema.optionalKey(TrimmedString),
      otlpMetricsUrl: Schema.optionalKey(TrimmedString),
    }),
  ),
  providers: Schema.optionalKey(
    Schema.Struct({
      codex: Schema.optionalKey(CodexSettingsPatch),
      claudeAgent: Schema.optionalKey(ClaudeSettingsPatch),
      grok: Schema.optionalKey(GrokSettingsPatch),
      kimi: Schema.optionalKey(KimiSettingsPatch),
      opencode: Schema.optionalKey(OpenCodeSettingsPatch),
      opencodeGo: Schema.optionalKey(OpenCodeGoSettingsPatch),
    }),
  ),
  // Whole-map replacement for the new instance config. Patching individual
  // entries is intentionally out of scope: the map is small, and partial
  // patches risk leaving driver-specific config in a half-merged state.
  // The web UI sends a fully-formed map every time it edits this field.
  providerInstances: Schema.optionalKey(Schema.Record(ProviderInstanceId, ProviderInstanceConfig)),
  channelConnections: Schema.optionalKey(Schema.Array(ChannelConnectionProfile)),
} as const;

export const ServerSettingsPatch = Schema.Struct(ServerSettingsPatchFields);

export type ServerSettingsPatch = typeof ServerSettingsPatch.Type;

export const ServerSettingsRpcPatch = Schema.Struct(
  Struct.omit(ServerSettingsPatchFields, ["channelConnections"]),
);

export type ServerSettingsRpcPatch = typeof ServerSettingsRpcPatch.Type;

/**
 * Default enabled state for a built-in driver when neither the envelope nor
 * the config blob carries a flag. Derived from the driver's settings schema
 * through `DEFAULT_SERVER_SETTINGS`, so the schema's decoding default stays
 * the single source of truth. Unknown (fork) drivers default to enabled.
 */
const legacyDefaults = new Map(Object.entries(DEFAULT_SERVER_SETTINGS.providers));

export const defaultEnabledForDriver = (driver: ProviderDriverKind): boolean => {
  return legacyDefaults.get(driver)?.enabled ?? true;
};

/**
 * Resolve whether a configured provider instance is enabled. An explicit
 * false on either the envelope or the in-config flag wins (most
 * restrictive), so a user's disable is never silently undone by the other
 * flag. Otherwise: envelope, then config, then the driver's default.
 */
export const resolveProviderInstanceEnabled = (
  instance: Pick<ProviderInstanceConfig, "driver" | "enabled" | "config">,
): boolean => {
  const configEnabled = providerInstanceConfigEnabledFlag(instance.config);

  if (instance.enabled === false || configEnabled === false) {
    return false;
  }

  return instance.enabled ?? configEnabled ?? defaultEnabledForDriver(instance.driver);
};
