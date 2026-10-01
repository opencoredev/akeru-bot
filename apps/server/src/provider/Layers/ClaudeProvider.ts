import { type ClaudeSettings } from "@akeru/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { resolveSpawnCommand } from "@akeru/shared/shell";
import {
  buildServerProvider,
  DEFAULT_TIMEOUT_MS,
  isCommandMissingCause,
  parseGenericCliVersion,
  providerModelsFromSettings,
  spawnAndCollect,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";
import { claudeEnvironmentForConfig } from "../Drivers/ClaudeHome.ts";
import { discoverClaudeSkills } from "../Drivers/ClaudeSkills.ts";

import {
  DEFAULT_CLAUDE_MODEL_CAPABILITIES,
  BUILT_IN_MODELS,
  supportsClaudeOpus5,
  supportsClaudeFable5,
  supportsClaudeOpus48,
  supportsClaudeOpus47,
  getBuiltInClaudeModelsForVersion,
  formatClaudeOpus5UpgradeMessage,
  formatClaudeFable5UpgradeMessage,
  formatClaudeOpus48UpgradeMessage,
  formatClaudeOpus47UpgradeMessage,
} from "./claude/ClaudeModels.ts";
import { claudeAuthMetadata, apiProviderAuthMetadata } from "./claude/ClaudeAuthMetadata.ts";
import {
  type ClaudeCapabilitiesProbe,
  dedupeSlashCommands,
  probeClaudeCapabilities,
} from "./claude/ClaudeCapabilitiesProbe.ts";

const CLAUDE_PRESENTATION = {
  displayName: "Claude",
  showInteractionModeToggle: true,
} as const;

const runClaudeCommand = Effect.fn("runClaudeCommand")(function* (
  claudeSettings: ClaudeSettings,
  args: ReadonlyArray<string>,
  environment?: NodeJS.ProcessEnv,
) {
  const claudeEnvironment = yield* claudeEnvironmentForConfig(claudeSettings, environment);

  const spawnCommand = yield* resolveSpawnCommand(claudeSettings.binaryPath, args, {
    env: claudeEnvironment,
  });

  const command = ChildProcess.make(spawnCommand.command, spawnCommand.args, {
    env: claudeEnvironment,
    shell: spawnCommand.shell,
  });

  return yield* spawnAndCollect(claudeSettings.binaryPath, command);
});

export const checkClaudeProviderStatus = Effect.fn("checkClaudeProviderStatus")(function* (
  claudeSettings: ClaudeSettings,
  resolveCapabilities?: (
    claudeSettings: ClaudeSettings,
  ) => Effect.Effect<ClaudeCapabilitiesProbe | undefined>,
  environment?: NodeJS.ProcessEnv,
  cwd?: string,
): Effect.fn.Return<
  ServerProviderDraft,
  never,
  ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
> {
  const resolvedEnvironment = environment ?? process.env;
  const checkedAt = DateTime.formatIso(yield* DateTime.now);

  const allModels = providerModelsFromSettings(
    BUILT_IN_MODELS,
    claudeSettings.customModels,
    DEFAULT_CLAUDE_MODEL_CAPABILITIES,
  );

  if (!claudeSettings.enabled) {
    return buildServerProvider({
      presentation: CLAUDE_PRESENTATION,
      enabled: false,
      checkedAt,
      models: allModels,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Claude is disabled in Akeru Bot settings.",
      },
    });
  }

  const versionProbe = yield* runClaudeCommand(
    claudeSettings,
    ["--version"],
    resolvedEnvironment,
  ).pipe(Effect.timeoutOption(DEFAULT_TIMEOUT_MS), Effect.result);

  if (Result.isFailure(versionProbe)) {
    const error = versionProbe.failure;
    yield* Effect.logWarning("Claude Agent CLI health check failed.", {
      errorTag: error._tag,
    });

    return buildServerProvider({
      presentation: CLAUDE_PRESENTATION,
      enabled: claudeSettings.enabled,
      checkedAt,
      models: allModels,
      probe: {
        installed: !isCommandMissingCause(error),
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: isCommandMissingCause(error)
          ? "Claude Agent CLI (`claude`) was not found on PATH."
          : "Failed to execute Claude Agent CLI health check.",
      },
    });
  }

  if (Option.isNone(versionProbe.success)) {
    return buildServerProvider({
      presentation: CLAUDE_PRESENTATION,
      enabled: claudeSettings.enabled,
      checkedAt,
      models: allModels,
      probe: {
        installed: true,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message:
          "Claude Agent CLI is installed but failed to run. Timed out while running command.",
      },
    });
  }

  const version = versionProbe.success.value;
  const parsedVersion = parseGenericCliVersion(`${version.stdout}\n${version.stderr}`);

  if (version.code !== 0) {
    yield* Effect.logWarning("Claude Agent CLI version probe exited with a non-zero status.", {
      exitCode: version.code,
      stdoutLength: version.stdout.length,
      stderrLength: version.stderr.length,
    });

    return buildServerProvider({
      presentation: CLAUDE_PRESENTATION,
      enabled: claudeSettings.enabled,
      checkedAt,
      models: allModels,
      probe: {
        installed: true,
        version: parsedVersion,
        status: "error",
        auth: { status: "unknown" },
        message: "Claude Agent CLI is installed but failed to run.",
      },
    });
  }

  const models = providerModelsFromSettings(
    getBuiltInClaudeModelsForVersion(parsedVersion),
    claudeSettings.customModels,
    DEFAULT_CLAUDE_MODEL_CAPABILITIES,
  );

  const versionUpgradeMessage = supportsClaudeOpus5(parsedVersion)
    ? undefined
    : supportsClaudeFable5(parsedVersion)
      ? formatClaudeOpus5UpgradeMessage(parsedVersion)
      : supportsClaudeOpus48(parsedVersion)
        ? formatClaudeFable5UpgradeMessage(parsedVersion)
        : supportsClaudeOpus47(parsedVersion)
          ? formatClaudeOpus48UpgradeMessage(parsedVersion)
          : formatClaudeOpus47UpgradeMessage(parsedVersion);

  const capabilities = resolveCapabilities
    ? yield* resolveCapabilities(claudeSettings).pipe(Effect.orElseSucceed(() => undefined))
    : undefined;

  const skills = yield* discoverClaudeSkills(claudeSettings, cwd, resolvedEnvironment);

  const slashCommands = [
    {
      name: "compact",
      description: "Summarize the conversation and reduce context usage",
    },
    ...(capabilities?.slashCommands ?? []),
  ];

  const dedupedSlashCommands = dedupeSlashCommands(slashCommands);

  if (!capabilities) {
    return buildServerProvider({
      presentation: CLAUDE_PRESENTATION,
      enabled: claudeSettings.enabled,
      checkedAt,
      models,
      slashCommands: dedupedSlashCommands,
      skills,
      probe: {
        installed: true,
        version: parsedVersion,
        status: "warning",
        auth: { status: "unknown" },
        message: "Could not verify Claude authentication status from initialization result.",
      },
    });
  }

  const authMetadata =
    claudeAuthMetadata({
      subscriptionType: capabilities.subscriptionType,
      authMethod: capabilities.tokenSource,
    }) ?? apiProviderAuthMetadata(capabilities.apiProvider);

  return buildServerProvider({
    presentation: CLAUDE_PRESENTATION,
    enabled: claudeSettings.enabled,
    checkedAt,
    models,
    slashCommands: dedupedSlashCommands,
    skills,
    probe: {
      installed: true,
      version: parsedVersion,
      status: "ready",
      auth: {
        status: "authenticated",
        ...(capabilities.email ? { email: capabilities.email } : {}),
        ...(authMetadata ? authMetadata : {}),
      },
      ...(versionUpgradeMessage ? { message: versionUpgradeMessage } : {}),
    },
  });
});

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

export const pendingClaudeProvider = (
  claudeSettings: ClaudeSettings,
): Effect.Effect<ServerProviderDraft> =>
  Effect.gen(function* () {
    const checkedAt = yield* nowIso;

    const models = providerModelsFromSettings(
      BUILT_IN_MODELS,
      claudeSettings.customModels,
      DEFAULT_CLAUDE_MODEL_CAPABILITIES,
    );

    if (!claudeSettings.enabled) {
      return buildServerProvider({
        presentation: CLAUDE_PRESENTATION,
        enabled: false,
        checkedAt,
        models,
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "Claude is disabled in Akeru Bot settings.",
        },
      });
    }

    return buildServerProvider({
      presentation: CLAUDE_PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Claude provider status has not been checked in this session yet.",
      },
    });
  });

export { probeClaudeCapabilities };

export {
  getClaudeModelCapabilities,
  resolveClaudeEffort,
  normalizeClaudeCliEffort,
  isClaudeUltracodeEffort,
  resolveClaudeContextWindow,
  resolveClaudeApiModelId,
} from "./claude/ClaudeModels.ts";

export {
  CLAUDE_CAPABILITIES_PROBE_SETTING_SOURCES,
  buildClaudeCapabilitiesProbeQueryOptions,
} from "./claude/ClaudeCapabilitiesProbe.ts";
