import {
  DEFAULT_BOT_SANDBOX_BROWSER_SHARING,
  type PortabilityProjectData,
  type PortabilitySafeServerSettings,
  type OrchestrationReadModel,
  type ServerSettings,
  type ServerSettingsPatch,
} from "@akeru/contracts";
import * as Duration from "effect/Duration";

const SECRET_ARGUMENT =
  /(?:api[-_]?key|authorization|bearer|cookie|credential|password|secret|token)/i;

export function hasAbsolutePath(value: string): boolean {
  return value.startsWith("/") || /^[a-z]:[\\/]/i.test(value) || value.startsWith("file://");
}

export function containsAbsolutePath(value: string): boolean {
  return hasAbsolutePath(value) || /(?:^|[=:"'])(?:\/(?!\/)|[a-z]:[\\/]|file:\/\/)/i.test(value);
}

export function basename(value: string): string {
  return value.replaceAll("\\", "/").split("/").at(-1) ?? value;
}

export function safeMcpCommand(command: string): string {
  const executable = command.trim().split(/\s+/)[0] ?? command;

  if (SECRET_ARGUMENT.test(executable) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(executable)) {
    return "mcp-server";
  }

  return hasAbsolutePath(executable) ? basename(executable) : executable;
}

export function safeText(value: string): string {
  if (/^diff --git /m.test(value)) return "[diff removed]";

  return value
    .replace(/-----BEGIN [A-Z0-9 ]+-----[\s\S]*?-----END [A-Z0-9 ]+-----/g, "[private key removed]")
    .replace(
      /(["']?(?:api[-_]?key|authorization|cookie|credential|password|secret|token)["']?\s*:\s*)["'][^"'\r\n]+["']/gi,
      '$1"[secret removed]"',
    )
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+:[^@\s/]+@/gi, "$1[credentials removed]@")
    .replace(/\bBearer\s+\S+/gi, "[secret removed]")
    .replace(/\b(?:sk|ghp|github_pat|xox[baprs])-[_A-Za-z0-9-]+\b/gi, "[secret removed]")
    .replace(/\b(?:glpat-|npm_)[_A-Za-z0-9-]+\b/gi, "[secret removed]")
    .replace(/\b(?:sk|rk)_(?:live|test)_[_A-Za-z0-9-]+\b/gi, "[secret removed]")
    .replace(/\bAIza[_A-Za-z0-9-]{20,}\b/g, "[secret removed]")
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[secret removed]")
    .replace(/\bxai-[_A-Za-z0-9-]+\b/gi, "[secret removed]")
    .replace(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, "[secret removed]")
    .replace(/\b(?:authorization|cookie|set-cookie)\s*:\s*[^\r\n]+/gi, "[secret removed]")
    .replace(
      /\b(?:api[-_]?key|pairing[-_]?token|password|relay[-_]?token|secret|token)\s*[:=]\s*\S+/gi,
      "[secret removed]",
    )
    .replace(/\b[A-Z][A-Z0-9_]{1,}\s*=\s*\S+/g, "[environment variable removed]")
    .replace(/\brefs\/(?:heads|remotes|tags)\/\S+/g, "[Git ref removed]")
    .replace(/(^|[\s"'`(])\/(?:[^/\s"'`)]+\/)*[^/\s"'`)]+/gm, "$1[local path removed]")
    .replace(/(^|[\s"'`(])~\/(?:[^/\s"'`)]+\/)*[^/\s"'`)]+/gm, "$1[local path removed]")
    .replace(/[A-Za-z]:\\(?:[^\s\\]+\\)+[^\s\\]+/g, "[local path removed]");
}

export function portableProjectData(
  project: OrchestrationReadModel["projects"][number],
): PortabilityProjectData {
  const repository = project.repositoryIdentity
    ? Object.fromEntries(
        Object.entries({
          displayName:
            project.repositoryIdentity.displayName === undefined
              ? undefined
              : safeText(project.repositoryIdentity.displayName),
          provider:
            project.repositoryIdentity.provider === undefined
              ? undefined
              : safeText(project.repositoryIdentity.provider),
          owner:
            project.repositoryIdentity.owner === undefined
              ? undefined
              : safeText(project.repositoryIdentity.owner),
          name:
            project.repositoryIdentity.name === undefined
              ? undefined
              : safeText(project.repositoryIdentity.name),
        }).filter(([, value]) => value !== undefined),
      )
    : undefined;

  return {
    title: safeText(project.title),
    workspaceName: safeText(basename(project.workspaceRoot) || project.title),
    ...(repository && Object.keys(repository).length > 0 ? { repository } : {}),
    defaultModelSelection: project.defaultModelSelection,
    ...(project.defaultThreadEnvMode !== undefined
      ? { defaultThreadEnvMode: project.defaultThreadEnvMode }
      : {}),
  };
}

export function safeMcpArgs(args: readonly string[] | undefined): string[] | undefined {
  if (args === undefined) return undefined;
  const safe: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    const next = args[index + 1];

    if (argument.startsWith("-") && next && containsAbsolutePath(next)) {
      index += 1;
      continue;
    }

    if (
      containsAbsolutePath(argument) ||
      /^[A-Za-z_][A-Za-z0-9_]*=/.test(argument) ||
      safeText(argument) !== argument
    )
      continue;

    if (SECRET_ARGUMENT.test(argument)) {
      if (!argument.includes("=") && args[index + 1] && !args[index + 1]!.startsWith("-")) {
        index += 1;
      }

      continue;
    }

    safe.push(argument);
  }

  return safe.length > 0 ? safe : undefined;
}

export function safeMcpConfiguration(
  server: NonNullable<OrchestrationReadModel["mcpServers"]>[number],
) {
  if (server.transport === "stdio") {
    const args = safeMcpArgs(server.args);

    return {
      name: safeText(server.name),
      transport: server.transport,
      command: safeMcpCommand(server.command),
      ...(args ? { args } : {}),
    } as const;
  }

  const url = new URL(server.url);
  url.username = "";
  url.password = "";
  url.search = "";
  url.hash = "";

  return { name: safeText(server.name), transport: server.transport, url: url.toString() } as const;
}

export function safeServerSettings(settings: ServerSettings): PortabilitySafeServerSettings {
  const overrides = settings.backgroundActivity.overrides;

  return {
    enableLegacyTokenStreaming: settings.enableLegacyTokenStreaming,
    enableProviderUpdateChecks: settings.enableProviderUpdateChecks,
    enableAgentBrowserAccess: settings.enableAgentBrowserAccess,
    botSandboxBrowserSharing: settings.botSandboxBrowserSharing,
    backgroundActivity: {
      schemaVersion: 1,
      profile: settings.backgroundActivity.profile,
      ...(settings.backgroundActivity.baseProfile
        ? { baseProfile: settings.backgroundActivity.baseProfile }
        : {}),
      overrides: {
        ...(overrides.automaticGitFetchInterval
          ? {
              automaticGitFetchIntervalMs: Duration.toMillis(overrides.automaticGitFetchInterval),
            }
          : {}),
        ...(overrides.providerHealthRefreshInterval
          ? {
              providerHealthRefreshIntervalMs: Duration.toMillis(
                overrides.providerHealthRefreshInterval,
              ),
            }
          : {}),
        ...(overrides.hostPowerMonitorActiveInterval
          ? {
              hostPowerMonitorActiveIntervalMs: Duration.toMillis(
                overrides.hostPowerMonitorActiveInterval,
              ),
            }
          : {}),
        ...(overrides.hostPowerMonitorIdleInterval
          ? {
              hostPowerMonitorIdleIntervalMs: Duration.toMillis(
                overrides.hostPowerMonitorIdleInterval,
              ),
            }
          : {}),
        ...(overrides.idleClientTtl
          ? { idleClientTtlMs: Duration.toMillis(overrides.idleClientTtl) }
          : {}),
        ...(overrides.pauseWhenHostLocked !== undefined
          ? { pauseWhenHostLocked: overrides.pauseWhenHostLocked }
          : {}),
        ...(overrides.pauseWhenHostLowPower !== undefined
          ? { pauseWhenHostLowPower: overrides.pauseWhenHostLowPower }
          : {}),
        ...(overrides.pauseWhenClientLowPower !== undefined
          ? { pauseWhenClientLowPower: overrides.pauseWhenClientLowPower }
          : {}),
        ...(overrides.pauseWhenOnBattery !== undefined
          ? { pauseWhenOnBattery: overrides.pauseWhenOnBattery }
          : {}),
      },
    },
    automaticGitFetchIntervalMs: Duration.toMillis(settings.automaticGitFetchInterval),
    providerHealthRefreshIntervalMs: Duration.toMillis(settings.providerHealthRefreshInterval),
    backgroundActivityProfile: settings.backgroundActivityProfile,
    defaultThreadEnvMode: settings.defaultThreadEnvMode,
    newWorktreesStartFromOrigin: settings.newWorktreesStartFromOrigin,
    textGenerationModelSelection: settings.textGenerationModelSelection,
    sourceControlWritingStyle: {
      ...settings.sourceControlWritingStyle,
      customInstructions: safeText(settings.sourceControlWritingStyle.customInstructions),
    },
    sourceControlWriterModelSelection: settings.sourceControlWriterModelSelection,
  };
}

export function settingsPatchFromPortable(
  settings: PortabilitySafeServerSettings,
): ServerSettingsPatch {
  const overrides = settings.backgroundActivity.overrides;

  return {
    enableLegacyTokenStreaming: settings.enableLegacyTokenStreaming,
    enableProviderUpdateChecks: settings.enableProviderUpdateChecks,
    enableAgentBrowserAccess: settings.enableAgentBrowserAccess,
    botSandboxBrowserSharing:
      settings.botSandboxBrowserSharing ?? DEFAULT_BOT_SANDBOX_BROWSER_SHARING,
    backgroundActivity: {
      schemaVersion: 1,
      profile: settings.backgroundActivity.profile,
      ...(settings.backgroundActivity.baseProfile
        ? { baseProfile: settings.backgroundActivity.baseProfile }
        : {}),
      overrides: {
        ...(overrides.automaticGitFetchIntervalMs !== undefined
          ? {
              automaticGitFetchInterval: Duration.millis(overrides.automaticGitFetchIntervalMs),
            }
          : {}),
        ...(overrides.providerHealthRefreshIntervalMs !== undefined
          ? {
              providerHealthRefreshInterval: Duration.millis(
                overrides.providerHealthRefreshIntervalMs,
              ),
            }
          : {}),
        ...(overrides.hostPowerMonitorActiveIntervalMs !== undefined
          ? {
              hostPowerMonitorActiveInterval: Duration.millis(
                overrides.hostPowerMonitorActiveIntervalMs,
              ),
            }
          : {}),
        ...(overrides.hostPowerMonitorIdleIntervalMs !== undefined
          ? {
              hostPowerMonitorIdleInterval: Duration.millis(
                overrides.hostPowerMonitorIdleIntervalMs,
              ),
            }
          : {}),
        ...(overrides.idleClientTtlMs !== undefined
          ? { idleClientTtl: Duration.millis(overrides.idleClientTtlMs) }
          : {}),
        ...(overrides.pauseWhenHostLocked !== undefined
          ? { pauseWhenHostLocked: overrides.pauseWhenHostLocked }
          : {}),
        ...(overrides.pauseWhenHostLowPower !== undefined
          ? { pauseWhenHostLowPower: overrides.pauseWhenHostLowPower }
          : {}),
        ...(overrides.pauseWhenClientLowPower !== undefined
          ? { pauseWhenClientLowPower: overrides.pauseWhenClientLowPower }
          : {}),
        ...(overrides.pauseWhenOnBattery !== undefined
          ? { pauseWhenOnBattery: overrides.pauseWhenOnBattery }
          : {}),
      },
    },
    automaticGitFetchInterval: Duration.millis(settings.automaticGitFetchIntervalMs),
    providerHealthRefreshInterval: Duration.millis(settings.providerHealthRefreshIntervalMs),
    backgroundActivityProfile: settings.backgroundActivityProfile,
    defaultThreadEnvMode: settings.defaultThreadEnvMode,
    newWorktreesStartFromOrigin: settings.newWorktreesStartFromOrigin,
    textGenerationModelSelection: settings.textGenerationModelSelection,
    sourceControlWritingStyle: settings.sourceControlWritingStyle,
    sourceControlWriterModelSelection: settings.sourceControlWriterModelSelection,
  };
}
