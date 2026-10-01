import type { ProviderInstanceConfig } from "../providerInstance.ts";
import * as Predicate from "effect/Predicate";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { TrimmedString } from "../baseSchemas.ts";
import { binaryPathSetting, providerSettingsSchema } from "./providerForms.ts";

export const CodexSettings = providerSettingsSchema(
  {
    enabled: Schema.Boolean.pipe(
      Schema.withDecodingDefault(Effect.succeed(true)),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
    binaryPath: binaryPathSetting("codex").pipe(
      Schema.annotateKey({
        title: "Binary path",
        description: "Path to the Codex binary used by this instance.",
        providerSettingsForm: { placeholder: "codex", clearWhenEmpty: "omit" },
      }),
    ),
    homePath: TrimmedString.pipe(
      Schema.withDecodingDefault(Effect.succeed("")),
      Schema.annotateKey({
        title: "CODEX_HOME path",
        description: "Custom Codex home and config directory.",
        providerSettingsForm: {
          placeholder: "~/.codex",
          clearWhenEmpty: "omit",
        },
      }),
    ),
    shadowHomePath: TrimmedString.pipe(
      Schema.withDecodingDefault(Effect.succeed("")),
      Schema.annotateKey({
        title: "Shadow home path",
        description:
          "Account-specific Codex home. Keeps auth.json separate while sharing state from CODEX_HOME.",
        providerSettingsForm: {
          placeholder: "~/.codex-akeru/personal",
          clearWhenEmpty: "omit",
        },
      }),
    ),
    launchArgs: TrimmedString.pipe(
      Schema.withDecodingDefault(Effect.succeed("")),
      Schema.annotateKey({
        title: "Launch arguments",
        description: "Additional CLI arguments passed to codex app-server on session start.",
      }),
    ),
    customModels: Schema.Array(Schema.String).pipe(
      Schema.withDecodingDefault(Effect.succeed([])),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
  },
  {
    order: ["binaryPath", "homePath", "shadowHomePath", "launchArgs"],
  },
);

export type CodexSettings = typeof CodexSettings.Type;

// Empty, or an integer from 100,000 to 1,000,000. Shared by the full
// Claude settings schema and its patch so an out-of-range value fails at
// the update that introduced it.
const CLAUDE_AUTO_COMPACT_WINDOW_PATTERN = /^(?:|[1-9]\d{5}|1000000)$/;

export const ClaudeSettings = providerSettingsSchema(
  {
    enabled: Schema.Boolean.pipe(
      Schema.withDecodingDefault(Effect.succeed(true)),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
    binaryPath: binaryPathSetting("claude").pipe(
      Schema.annotateKey({
        title: "Binary path",
        description: "Path to the Claude binary used by this instance.",
        providerSettingsForm: { placeholder: "claude", clearWhenEmpty: "omit" },
      }),
    ),
    homePath: TrimmedString.pipe(
      Schema.withDecodingDefault(Effect.succeed("")),
      Schema.annotateKey({
        title: "CLAUDE_CONFIG_DIR path",
        description:
          "Custom Claude home and config directory. Keeps .claude.json and .claude separate.",
        providerSettingsForm: { placeholder: "~/.claude", clearWhenEmpty: "omit" },
      }),
    ),
    customModels: Schema.Array(Schema.String).pipe(
      Schema.withDecodingDefault(Effect.succeed([])),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
    launchArgs: Schema.String.pipe(
      Schema.withDecodingDefault(Effect.succeed("")),
      Schema.annotateKey({
        title: "Launch arguments",
        description: "Additional CLI arguments passed on session start.",
        providerSettingsForm: {
          placeholder: "e.g. --chrome",
          clearWhenEmpty: "omit",
        },
      }),
    ),
    autoCompactWindow: TrimmedString.check(
      Schema.isPattern(CLAUDE_AUTO_COMPACT_WINDOW_PATTERN),
    ).pipe(
      Schema.withDecodingDefault(Effect.succeed("")),
      Schema.annotateKey({
        title: "Auto-compact after",
        description:
          "Compact after 100,000 to 1,000,000 tokens. Leave empty to use Claude's default.",
        providerSettingsForm: {
          placeholder: "e.g. 300000",
          clearWhenEmpty: "omit",
        },
      }),
    ),
  },
  {
    order: ["binaryPath", "homePath", "autoCompactWindow", "launchArgs"],
  },
);

export type ClaudeSettings = typeof ClaudeSettings.Type;

export const GrokSettings = providerSettingsSchema(
  {
    // Off by default: the binding is not yet
    // stable enough to probe on every install. Users opt in from Settings.
    enabled: Schema.Boolean.pipe(
      Schema.withDecodingDefault(Effect.succeed(false)),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
    binaryPath: binaryPathSetting("grok").pipe(
      Schema.annotateKey({
        title: "Binary path",
        description: "Path to the Grok CLI binary.",
        providerSettingsForm: { placeholder: "grok", clearWhenEmpty: "omit" },
      }),
    ),
    customModels: Schema.Array(Schema.String).pipe(
      Schema.withDecodingDefault(Effect.succeed([])),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
    verboseProtocolLogging: Schema.Boolean.pipe(
      Schema.withDecodingDefault(Effect.succeed(false)),
      Schema.annotateKey({
        title: "Verbose protocol logging",
        description: "Record full ACP protocol diagnostics in provider event logs.",
        providerSettingsForm: { control: "switch" },
      }),
    ),
  },
  {
    order: ["binaryPath", "verboseProtocolLogging"],
  },
);

export type GrokSettings = typeof GrokSettings.Type;

export const KimiSettings = providerSettingsSchema({
  enabled: Schema.Boolean.pipe(
    Schema.withDecodingDefault(Effect.succeed(true)),
    Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
  ),
  customModels: Schema.Array(Schema.String).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
    Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
  ),
});

export type KimiSettings = typeof KimiSettings.Type;

export const OpenCodeGoSettings = providerSettingsSchema({
  enabled: Schema.Boolean.pipe(
    Schema.withDecodingDefault(Effect.succeed(true)),
    Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
  ),
  customModels: Schema.Array(Schema.String).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
    Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
  ),
});

export type OpenCodeGoSettings = typeof OpenCodeGoSettings.Type;

export const OpenCodeSettings = providerSettingsSchema(
  {
    // Off by default: the binding is not yet stable
    // enough to probe on every install. Users opt in from Settings.
    enabled: Schema.Boolean.pipe(
      Schema.withDecodingDefault(Effect.succeed(false)),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
    binaryPath: binaryPathSetting("opencode").pipe(
      Schema.annotateKey({
        title: "Binary path",
        description: "Path to the OpenCode binary.",
        providerSettingsForm: {
          placeholder: "opencode",
          clearWhenEmpty: "omit",
        },
      }),
    ),
    serverUrl: TrimmedString.pipe(
      Schema.withDecodingDefault(Effect.succeed("")),
      Schema.annotateKey({
        title: "Server URL",
        description: "Leave blank to let Akeru Bot spawn the server when needed.",
        providerSettingsForm: {
          placeholder: "http://127.0.0.1:4096",
          clearWhenEmpty: "omit",
        },
      }),
    ),
    serverPassword: TrimmedString.pipe(
      Schema.withDecodingDefault(Effect.succeed("")),
      Schema.annotateKey({
        title: "Server password",
        description: "Stored in plain text on disk.",
        providerSettingsForm: {
          control: "password",
          placeholder: "Optional",
          clearWhenEmpty: "omit",
        },
      }),
    ),
    customModels: Schema.Array(Schema.String).pipe(
      Schema.withDecodingDefault(Effect.succeed([])),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
  },
  {
    order: ["binaryPath", "serverUrl", "serverPassword"],
  },
);

export type OpenCodeSettings = typeof OpenCodeSettings.Type;

/**
 * Read the legacy `enabled` flag embedded in a provider instance config
 * blob. The envelope-level `ProviderInstanceConfig.enabled` is the single
 * flag going forward; this reader exists for legacy `providers.<kind>`
 * blobs and old settings files that still carry the flag in-config.
 */
export const providerInstanceConfigEnabledFlag = (
  config: ProviderInstanceConfig["config"],
): boolean | undefined => {
  if (
    config === null ||
    !(Predicate.isObjectOrArray(config) || config === null) ||
    Array.isArray(config)
  ) {
    return undefined;
  }

  const enabled = "enabled" in config ? config.enabled : undefined;

  return Predicate.isBoolean(enabled) ? enabled : undefined;
};

export const CodexSettingsPatch = Schema.Struct({
  enabled: Schema.optionalKey(Schema.Boolean),
  binaryPath: Schema.optionalKey(TrimmedString),
  homePath: Schema.optionalKey(TrimmedString),
  shadowHomePath: Schema.optionalKey(TrimmedString),
  launchArgs: Schema.optionalKey(TrimmedString),
  customModels: Schema.optionalKey(Schema.Array(Schema.String)),
});

export const ClaudeSettingsPatch = Schema.Struct({
  enabled: Schema.optionalKey(Schema.Boolean),
  binaryPath: Schema.optionalKey(TrimmedString),
  homePath: Schema.optionalKey(TrimmedString),
  customModels: Schema.optionalKey(Schema.Array(Schema.String)),
  launchArgs: Schema.optionalKey(TrimmedString),
  // Validated at the patch boundary so a typo fails the one update with a
  // schema error instead of a generic whole-settings failure.
  autoCompactWindow: Schema.optionalKey(
    TrimmedString.check(Schema.isPattern(CLAUDE_AUTO_COMPACT_WINDOW_PATTERN)),
  ),
});

export const GrokSettingsPatch = Schema.Struct({
  enabled: Schema.optionalKey(Schema.Boolean),
  binaryPath: Schema.optionalKey(TrimmedString),
  customModels: Schema.optionalKey(Schema.Array(Schema.String)),
  verboseProtocolLogging: Schema.optionalKey(Schema.Boolean),
});

export const KimiSettingsPatch = Schema.Struct({
  enabled: Schema.optionalKey(Schema.Boolean),
  customModels: Schema.optionalKey(Schema.Array(Schema.String)),
});

export const OpenCodeGoSettingsPatch = Schema.Struct({
  enabled: Schema.optionalKey(Schema.Boolean),
  customModels: Schema.optionalKey(Schema.Array(Schema.String)),
});

export const OpenCodeSettingsPatch = Schema.Struct({
  enabled: Schema.optionalKey(Schema.Boolean),
  binaryPath: Schema.optionalKey(TrimmedString),
  serverUrl: Schema.optionalKey(TrimmedString),
  serverPassword: Schema.optionalKey(TrimmedString),
  customModels: Schema.optionalKey(Schema.Array(Schema.String)),
});
