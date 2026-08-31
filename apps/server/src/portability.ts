import * as NodeCrypto from "node:crypto";

import {
  AKERU_ARCHIVE_FORMAT,
  AKERU_ARCHIVE_VERSION,
  BotId,
  CommandId,
  GroupId,
  McpServerId,
  PortabilityArchive,
  ThreadId,
  type PortabilityArchiveRecord,
  type PortabilityImportItem,
  type PortabilityImportPreview,
  type PortabilitySafeServerSettings,
  type OrchestrationCommand,
  type OrchestrationReadModel,
  type ServerSettings,
  type ServerSettingsPatch,
} from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Schema from "effect/Schema";

const decodeArchive = Schema.decodeUnknownSync(PortabilityArchive);
const BUILTIN_MCP_PREFIX = "builtin-";
const SECRET_ARGUMENT =
  /(?:api[-_]?key|authorization|bearer|cookie|credential|password|secret|token)/i;
const ARCHIVE_RECORD_TYPES = [
  "bot",
  "group",
  "mcp-server",
  "project",
  "server-settings",
  "thread",
] as const;
const ARCHIVE_EXCLUSIONS = [
  "Access tokens, cookies, passwords, secret values, environment variables, pairing and relay credentials",
  "Absolute local paths, project scripts, attachments, image avatar files, Git refs, pull request links, and diff blobs",
  "Event identifiers, event sequences, command receipts, provider sessions, and opaque provider configuration",
  "Conversation messages, proposed plans, and approval history",
] as const;

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalValue(entry)]),
  );
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

export function portabilityChecksum(value: unknown): string {
  return NodeCrypto.createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function hasAbsolutePath(value: string): boolean {
  return value.startsWith("/") || /^[a-z]:[\\/]/i.test(value) || value.startsWith("file://");
}

function containsAbsolutePath(value: string): boolean {
  return hasAbsolutePath(value) || /(?:^|[=:"'])(?:\/(?!\/)|[a-z]:[\\/]|file:\/\/)/i.test(value);
}

function basename(value: string): string {
  return value.replaceAll("\\", "/").split("/").at(-1) ?? value;
}

function safeMcpCommand(command: string): string {
  const executable = command.trim().split(/\s+/)[0] ?? command;
  if (SECRET_ARGUMENT.test(executable) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(executable)) {
    return "mcp-server";
  }
  return hasAbsolutePath(executable) ? basename(executable) : executable;
}

function safeText(value: string): string {
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

function safeMcpArgs(args: readonly string[] | undefined): string[] | undefined {
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

function safeMcpConfiguration(server: NonNullable<OrchestrationReadModel["mcpServers"]>[number]) {
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

function settingsPatchFromPortable(settings: PortabilitySafeServerSettings): ServerSettingsPatch {
  const overrides = settings.backgroundActivity.overrides;
  return {
    enableLegacyTokenStreaming: settings.enableLegacyTokenStreaming,
    enableProviderUpdateChecks: settings.enableProviderUpdateChecks,
    enableAgentBrowserAccess: settings.enableAgentBrowserAccess,
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

type RecordCore = Omit<PortabilityArchiveRecord, "checksum">;

function withChecksum(record: RecordCore): PortabilityArchiveRecord {
  return { ...record, checksum: portabilityChecksum(record) } as PortabilityArchiveRecord;
}

export function portableRecords(
  snapshot: OrchestrationReadModel,
  settings: ServerSettings,
): PortabilityArchiveRecord[] {
  const mcpServerIds = new Set((snapshot.mcpServers ?? []).map((server) => server.id));
  const records: RecordCore[] = [
    {
      type: "server-settings",
      id: "server-settings",
      updatedAt: snapshot.updatedAt,
      data: safeServerSettings(settings),
    },
    ...(snapshot.mcpServers ?? []).map((server) => ({
      type: "mcp-server" as const,
      id: server.id,
      updatedAt: server.updatedAt,
      data: {
        ...(server.id.startsWith(BUILTIN_MCP_PREFIX)
          ? { catalogId: server.id.slice(BUILTIN_MCP_PREFIX.length) }
          : {}),
        configuration: safeMcpConfiguration(server),
      },
    })),
    ...snapshot.bots.map((bot) => ({
      type: "bot" as const,
      id: bot.id,
      updatedAt: bot.updatedAt,
      data: {
        name: safeText(bot.name),
        title: safeText(bot.title),
        label: bot.label === null ? null : safeText(bot.label),
        description: bot.description === null ? null : safeText(bot.description),
        disabledMcpServerIds: bot.disabledMcpServerIds
          .filter((id) => mcpServerIds.has(id))
          .toSorted(),
        avatar:
          bot.avatar.kind === "image" ? ({ kind: "dither", seed: bot.id } as const) : bot.avatar,
        engine: bot.engine,
        sandbox: bot.sandbox,
        runtimeMode: bot.runtimeMode,
        usageCap: bot.usageCap,
        voiceEnabled: bot.voiceEnabled,
        archived: bot.archivedAt !== null,
      },
    })),
    ...snapshot.groups.map((group) => ({
      type: "group" as const,
      id: group.id,
      updatedAt: group.updatedAt,
      data: {
        name: safeText(group.name),
        bossBotId: group.bossBotId,
        members: [...group.members].sort((left, right) => left.botId.localeCompare(right.botId)),
      },
    })),
    ...snapshot.projects.map((project) => {
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
        type: "project" as const,
        id: project.id,
        updatedAt: project.updatedAt,
        data: {
          title: safeText(project.title),
          workspaceName: safeText(basename(project.workspaceRoot) || project.title),
          ...(repository && Object.keys(repository).length > 0 ? { repository } : {}),
          defaultModelSelection: project.defaultModelSelection,
          ...(project.defaultThreadEnvMode !== undefined
            ? { defaultThreadEnvMode: project.defaultThreadEnvMode }
            : {}),
        },
      };
    }),
    ...snapshot.threads.map((thread) => ({
      type: "thread" as const,
      id: thread.id,
      updatedAt: thread.updatedAt,
      data: {
        projectId: thread.projectId,
        ...(thread.botId !== undefined ? { botId: thread.botId } : {}),
        ...(thread.groupId !== undefined ? { groupId: thread.groupId } : {}),
        title: safeText(thread.title),
        modelSelection: thread.modelSelection,
        runtimeMode: thread.runtimeMode,
        interactionMode: thread.interactionMode,
        createdAt: thread.createdAt,
        archivedAt: thread.archivedAt,
        ...(thread.pinnedAt !== undefined ? { pinnedAt: thread.pinnedAt } : {}),
      },
    })),
  ];
  return records
    .sort((left, right) =>
      left.type === right.type
        ? left.id.localeCompare(right.id)
        : left.type.localeCompare(right.type),
    )
    .map(withChecksum);
}

export function createPortabilityArchive(
  snapshot: OrchestrationReadModel,
  settings: ServerSettings,
  exportedAt: string,
) {
  const records = portableRecords(snapshot, settings);
  const body = {
    format: AKERU_ARCHIVE_FORMAT,
    version: AKERU_ARCHIVE_VERSION,
    exportedAt,
    manifest: {
      recordCounts: Object.fromEntries(
        ARCHIVE_RECORD_TYPES.map((type) => [
          type,
          records.filter((record) => record.type === type).length,
        ]),
      ),
      excluded: [...ARCHIVE_EXCLUSIONS],
    },
    records,
  } as const;
  return { ...body, checksum: portabilityChecksum(body) };
}

export function serializePortabilityArchive(archive: ReturnType<typeof createPortabilityArchive>) {
  return `${JSON.stringify(canonicalValue(archive), null, 2)}\n`;
}

function assertSafeImportedMcp(record: Extract<PortabilityArchiveRecord, { type: "mcp-server" }>) {
  if (
    record.data.catalogId !== undefined &&
    record.id !== `${BUILTIN_MCP_PREFIX}${record.data.catalogId}`
  ) {
    throw new Error(`MCP server '${record.id}' has an inconsistent catalog ID.`);
  }
  const config = record.data.configuration;
  if (config.transport === "stdio") {
    if (
      safeMcpCommand(config.command) !== config.command ||
      canonicalJson(safeMcpArgs(config.args) ?? []) !== canonicalJson(config.args ?? [])
    ) {
      throw new Error(`MCP server '${record.id}' contains a local path or credential argument.`);
    }
    return;
  }
  const url = new URL(config.url);
  if (url.username || url.password || url.search || url.hash) {
    throw new Error(`MCP server '${record.id}' contains URL credentials or query data.`);
  }
}

function assertSafeImportedText(label: string, value: string): void {
  if (safeText(value) !== value) throw new Error(`${label} contains unsafe text.`);
}

function assertSafeImportedRecord(record: PortabilityArchiveRecord): void {
  if (record.type === "server-settings") {
    assertSafeImportedText(
      "Source control custom instructions",
      record.data.sourceControlWritingStyle.customInstructions,
    );
    return;
  }
  if (record.type === "mcp-server") {
    assertSafeImportedText(`MCP server '${record.id}' name`, record.data.configuration.name);
    assertSafeImportedMcp(record);
    return;
  }
  if (record.type === "bot") {
    assertSafeImportedText(`Bot '${record.id}' name`, record.data.name);
    assertSafeImportedText(`Bot '${record.id}' title`, record.data.title);
    if (record.data.label !== null)
      assertSafeImportedText(`Bot '${record.id}' label`, record.data.label);
    if (record.data.description !== null)
      assertSafeImportedText(`Bot '${record.id}' description`, record.data.description);
    if (record.data.avatar.kind === "image") {
      throw new Error(`Bot '${record.id}' contains an image avatar path.`);
    }
    return;
  }
  if (record.type === "group") {
    assertSafeImportedText(`Group '${record.id}' name`, record.data.name);
    return;
  }
  if (record.type === "project") {
    assertSafeImportedText(`Project '${record.id}' title`, record.data.title);
    assertSafeImportedText(`Project '${record.id}' workspace name`, record.data.workspaceName);
    for (const value of Object.values(record.data.repository ?? {})) {
      if (value !== undefined) assertSafeImportedText(`Project '${record.id}' repository`, value);
    }
    return;
  }
  if (record.type === "thread") {
    assertSafeImportedText(`Thread '${record.id}' title`, record.data.title);
  }
}

export function parsePortabilityArchive(contents: string) {
  const archive = decodeArchive(JSON.parse(contents));
  const sorted = [...archive.records].sort((left, right) =>
    left.type === right.type
      ? left.id.localeCompare(right.id)
      : left.type.localeCompare(right.type),
  );
  if (archive.records.some((record, index) => record !== sorted[index])) {
    throw new Error("Archive records are not sorted.");
  }
  const keys = new Set<string>();
  for (const record of archive.records) {
    const key = `${record.type}:${record.id}`;
    if (keys.has(key)) throw new Error(`Archive contains duplicate record '${key}'.`);
    keys.add(key);
    const { checksum, ...core } = record;
    if (portabilityChecksum(core) !== checksum) throw new Error(`Checksum failed for '${key}'.`);
    assertSafeImportedRecord(record);
  }
  const { checksum, ...body } = archive;
  if (portabilityChecksum(body) !== checksum) throw new Error("Archive checksum failed.");
  const recordCounts = Object.fromEntries(
    ARCHIVE_RECORD_TYPES.map((type) => [
      type,
      archive.records.filter((record) => record.type === type).length,
    ]),
  );
  if (canonicalJson(archive.manifest.recordCounts) !== canonicalJson(recordCounts)) {
    throw new Error("Archive manifest record counts do not match its records.");
  }

  const botIds = new Set(
    archive.records.filter((record) => record.type === "bot").map((record) => record.id),
  );
  const mcpIds = new Set(
    archive.records.filter((record) => record.type === "mcp-server").map((record) => record.id),
  );
  const projectIds = new Set(
    archive.records.filter((record) => record.type === "project").map((record) => record.id),
  );
  const groupIds = new Set(
    archive.records.filter((record) => record.type === "group").map((record) => record.id),
  );
  const groupByBotId = new Map<string, string>();
  for (const record of archive.records) {
    if (record.type === "bot") {
      const missing = record.data.disabledMcpServerIds.find((id) => !mcpIds.has(id));
      if (missing)
        throw new Error(`Bot '${record.id}' references missing MCP server '${missing}'.`);
    }
    if (record.type === "group") {
      const memberIds = record.data.members.map((member) => member.botId);
      if (new Set(memberIds).size !== memberIds.length) {
        throw new Error(`Group '${record.id}' contains duplicate members.`);
      }
      const bosses = record.data.members.filter((member) => member.role === "boss");
      if (
        bosses.length > 1 ||
        (record.data.bossBotId === null && bosses.length !== 0) ||
        (record.data.bossBotId !== null &&
          (bosses.length !== 1 || bosses[0]!.botId !== record.data.bossBotId))
      ) {
        throw new Error(`Group '${record.id}' has inconsistent boss membership.`);
      }
      const referenced = [
        record.data.bossBotId,
        ...record.data.members.map((member) => member.botId),
      ];
      const missing = referenced.find((id) => id !== null && !botIds.has(id));
      if (missing) throw new Error(`Group '${record.id}' references missing bot '${missing}'.`);
      for (const member of record.data.members) {
        const existingGroupId = groupByBotId.get(member.botId);
        if (existingGroupId && existingGroupId !== record.id) {
          throw new Error(
            `Bot '${member.botId}' belongs to both group '${existingGroupId}' and '${record.id}'.`,
          );
        }
        groupByBotId.set(member.botId, record.id);
      }
    }
    if (record.type === "thread") {
      if (!projectIds.has(record.data.projectId)) {
        throw new Error(
          `Thread '${record.id}' references missing project '${record.data.projectId}'.`,
        );
      }
      if (record.data.botId && !botIds.has(record.data.botId)) {
        throw new Error(`Thread '${record.id}' references missing bot '${record.data.botId}'.`);
      }
      if (record.data.groupId && !groupIds.has(record.data.groupId)) {
        throw new Error(`Thread '${record.id}' references missing group '${record.data.groupId}'.`);
      }
    }
  }
  return archive;
}

function item(record: PortabilityArchiveRecord): PortabilityImportItem {
  const title =
    record.type === "server-settings"
      ? "Server settings"
      : record.type === "mcp-server"
        ? record.data.configuration.name
        : record.type === "bot" || record.type === "group"
          ? record.data.name
          : record.data.title;
  return { recordType: record.type, id: record.id, title };
}

export function portabilityStateChecksum(
  snapshot: OrchestrationReadModel,
  settings: ServerSettings,
  availableProviderIds: ReadonlySet<string>,
): string {
  return portabilityChecksum({
    snapshotSequence: snapshot.snapshotSequence,
    availableProviderIds: [...availableProviderIds].sort(),
    records: portableRecords(snapshot, settings),
  });
}

export function isPortabilityPreviewCurrent(
  snapshot: OrchestrationReadModel,
  settings: ServerSettings,
  availableProviderIds: ReadonlySet<string>,
  preview: Pick<PortabilityImportPreview, "snapshotSequence" | "stateChecksum">,
): boolean {
  return (
    snapshot.snapshotSequence === preview.snapshotSequence &&
    portabilityStateChecksum(snapshot, settings, availableProviderIds) === preview.stateChecksum
  );
}

export function previewPortabilityImport(
  archive: PortabilityArchive,
  snapshot: OrchestrationReadModel,
  settings: ServerSettings,
  availableProviderIds: ReadonlySet<string>,
): PortabilityImportPreview {
  const current = new Map(
    portableRecords(snapshot, settings).map((record) => [`${record.type}:${record.id}`, record]),
  );
  const additions: PortabilityImportItem[] = [];
  const changes: PortabilityImportItem[] = [];
  const conflicts: PortabilityImportItem[] = [];
  const currentProjectIds = new Set(snapshot.projects.map((project) => project.id));
  const currentBotGroupIds = new Map(snapshot.bots.map((bot) => [bot.id, bot.groupId]));
  const enabledMcpServerIds = new Set(
    (snapshot.mcpServers ?? []).filter((server) => server.enabled).map((server) => server.id),
  );
  const missingProviders = [
    ...new Set(
      archive.records.flatMap((record) =>
        (record.type === "bot" && record.data.engine
          ? [record.data.engine.provider]
          : record.type === "thread"
            ? [record.data.modelSelection.instanceId]
            : []
        ).filter((provider) => !availableProviderIds.has(provider)),
      ),
    ),
  ].sort();
  const missingProviderIds = new Set(missingProviders);
  const unavailableBotIds = new Set(
    archive.records.flatMap((record) =>
      record.type === "bot" &&
      record.data.engine &&
      missingProviderIds.has(record.data.engine.provider)
        ? [record.id]
        : [],
    ),
  );
  const unavailableGroupIds = new Set(
    archive.records.flatMap((record) => {
      if (record.type !== "group") return [];
      const hasUnavailableMember = record.data.members.some((member) =>
        unavailableBotIds.has(member.botId),
      );
      const hasAssignedMember = record.data.members.some((member) => {
        const groupId = currentBotGroupIds.get(member.botId);
        return groupId !== undefined && groupId !== null && groupId !== record.id;
      });
      return record.data.bossBotId === null || hasUnavailableMember || hasAssignedMember
        ? [record.id]
        : [];
    }),
  );
  const unsupportedCounts = new Map<"project" | "thread", number>();
  for (const record of archive.records) {
    if (
      record.type === "project" ||
      (record.type === "thread" && !currentProjectIds.has(record.data.projectId))
    ) {
      unsupportedCounts.set(record.type, (unsupportedCounts.get(record.type) ?? 0) + 1);
      continue;
    }
    if (
      (record.type === "bot" && unavailableBotIds.has(record.id)) ||
      (record.type === "group" && unavailableGroupIds.has(record.id)) ||
      (record.type === "thread" &&
        (missingProviderIds.has(record.data.modelSelection.instanceId) ||
          (record.data.botId !== undefined &&
            record.data.botId !== null &&
            unavailableBotIds.has(record.data.botId)) ||
          (record.data.groupId !== undefined &&
            record.data.groupId !== null &&
            unavailableGroupIds.has(record.data.groupId))))
    ) {
      conflicts.push(item(record));
      continue;
    }
    const existing = current.get(`${record.type}:${record.id}`);
    if (!existing) additions.push(item(record));
    else if (canonicalJson(existing.data) === canonicalJson(record.data)) {
      if (record.type === "mcp-server" && enabledMcpServerIds.has(McpServerId.make(record.id))) {
        changes.push(item(record));
      }
      continue;
    } else if (
      record.type === "thread" &&
      existing.type === "thread" &&
      (existing.data.projectId !== record.data.projectId ||
        existing.data.botId !== record.data.botId ||
        existing.data.groupId !== record.data.groupId)
    ) {
      conflicts.push(item(record));
    } else if (existing.updatedAt > record.updatedAt) {
      conflicts.push(item(record));
    } else changes.push(item(record));
  }
  return {
    snapshotSequence: snapshot.snapshotSequence,
    stateChecksum: portabilityStateChecksum(snapshot, settings, availableProviderIds),
    additions,
    changes,
    conflicts,
    missingProviders,
    skippedSecrets: [
      "Provider credentials and opaque provider configuration",
      "MCP credentials and environment variables",
      "Local paths, image avatar files, Git state, and event identifiers",
    ],
    unsupported: [
      ...[...unsupportedCounts.entries()].map(([kind, count]) => ({
        kind,
        count,
        reason:
          kind === "project"
            ? "Project roots are local absolute paths and require manual workspace mapping."
            : "The target project is not mapped on this environment.",
      })),
      { kind: "jobs" as const, count: 0, reason: "This build has no jobs projection." },
      { kind: "memory" as const, count: 0, reason: "This build has no durable memory projection." },
      { kind: "routines" as const, count: 0, reason: "This build has no routines projection." },
      {
        kind: "skill-assignments" as const,
        count: 0,
        reason: "This build has no skill assignment projection.",
      },
      {
        kind: "usage-history" as const,
        count: 0,
        reason: "Usage comes from provider transcript files, not an Akeru projection.",
      },
    ],
  };
}

function nextCommandId(): CommandId {
  return CommandId.make(`portability-${NodeCrypto.randomUUID()}`);
}

function mcpCommand(
  type: "mcp-server.create" | "mcp-server.update",
  record: Extract<PortabilityArchiveRecord, { type: "mcp-server" }>,
): OrchestrationCommand {
  const config = record.data.configuration;
  return {
    type,
    commandId: nextCommandId(),
    mcpServerId: McpServerId.make(record.id),
    ...config,
    ...(type === "mcp-server.create" ? { enabled: false, createdAt: record.updatedAt } : {}),
  } as OrchestrationCommand;
}

export function commandsForPortabilityImport(
  archive: PortabilityArchive,
  snapshot: OrchestrationReadModel,
  settings: ServerSettings,
  availableProviderIds: ReadonlySet<string>,
): {
  commands: OrchestrationCommand[];
  settingsPatch?: ServerSettingsPatch;
  applied: number;
  skipped: number;
} {
  const preview = previewPortabilityImport(archive, snapshot, settings, availableProviderIds);
  const conflictKeys = new Set(preview.conflicts.map((entry) => `${entry.recordType}:${entry.id}`));
  const mcpById = new Map((snapshot.mcpServers ?? []).map((server) => [server.id, server]));
  const botsById = new Map(snapshot.bots.map((bot) => [bot.id, bot]));
  const groupsById = new Map(snapshot.groups.map((group) => [group.id, group]));
  const threadsById = new Map(snapshot.threads.map((thread) => [thread.id, thread]));
  const referencedBotIds = new Set(
    archive.records.flatMap((record) =>
      record.type === "group"
        ? record.data.members.map((member) => member.botId)
        : record.type === "thread" && record.data.botId
          ? [record.data.botId]
          : [],
    ),
  );
  const commands: OrchestrationCommand[] = [];
  const deferredBotArchiveCommands: OrchestrationCommand[] = [];
  let settingsPatch: ServerSettingsPatch | undefined;
  let applied = 0;
  let skipped =
    preview.conflicts.length + preview.unsupported.reduce((total, entry) => total + entry.count, 0);

  for (const record of archive.records) {
    if (conflictKeys.has(`${record.type}:${record.id}`)) continue;
    if (record.type === "server-settings") {
      if (canonicalJson(safeServerSettings(settings)) !== canonicalJson(record.data)) {
        settingsPatch = settingsPatchFromPortable(record.data);
        applied += 1;
      }
      continue;
    }
    if (record.type !== "mcp-server") continue;
    const existing = mcpById.get(McpServerId.make(record.id));
    const currentConfig = existing ? safeMcpConfiguration(existing) : undefined;
    const configurationChanged =
      canonicalJson(currentConfig) !== canonicalJson(record.data.configuration);
    if (existing?.enabled) {
      commands.push({
        type: "mcp-server.disable",
        commandId: nextCommandId(),
        mcpServerId: McpServerId.make(record.id),
      });
    }
    if (!existing) commands.push(mcpCommand("mcp-server.create", record));
    else if (configurationChanged) {
      commands.push(mcpCommand("mcp-server.update", record));
    }
    if (!existing || configurationChanged || existing.enabled) {
      applied += 1;
    }
  }

  for (const record of archive.records) {
    if (record.type !== "bot" || conflictKeys.has(`bot:${record.id}`)) continue;
    const existing = botsById.get(BotId.make(record.id));
    const fields = {
      name: record.data.name,
      title: record.data.title,
      label: record.data.label,
      description: record.data.description,
      disabledMcpServerIds: record.data.disabledMcpServerIds,
      avatar: record.data.avatar,
      engine: record.data.engine,
      sandbox: record.data.sandbox,
      runtimeMode: record.data.runtimeMode,
      usageCap: record.data.usageCap,
      voiceEnabled: record.data.voiceEnabled,
    } as const;
    const changed =
      !existing ||
      canonicalJson(
        portableRecords({ ...snapshot, bots: [existing] }, settings).find(
          (entry) => entry.type === "bot",
        )?.data,
      ) !== canonicalJson(record.data);
    if (!existing) {
      commands.push({
        type: "bot.create",
        commandId: nextCommandId(),
        botId: BotId.make(record.id),
        ...fields,
        groupId: null,
        createdAt: record.updatedAt,
      });
    } else if (changed) {
      commands.push({
        type: "bot.update",
        commandId: nextCommandId(),
        botId: BotId.make(record.id),
        ...fields,
      });
    }
    const archived = existing ? existing.archivedAt !== null : false;
    if (archived && (!record.data.archived || referencedBotIds.has(BotId.make(record.id)))) {
      commands.push({
        type: "bot.restore",
        commandId: nextCommandId(),
        botId: BotId.make(record.id),
      });
    }
    if (record.data.archived && (!archived || referencedBotIds.has(BotId.make(record.id)))) {
      deferredBotArchiveCommands.push({
        type: "bot.archive",
        commandId: nextCommandId(),
        botId: BotId.make(record.id),
      });
    }
    if (changed) applied += 1;
  }

  for (const record of archive.records) {
    if (record.type !== "group" || conflictKeys.has(`group:${record.id}`)) continue;
    const existing = groupsById.get(GroupId.make(record.id));
    if (!existing) {
      commands.push({
        type: "group.create",
        commandId: nextCommandId(),
        groupId: GroupId.make(record.id),
        name: record.data.name,
        ...(record.data.bossBotId ? { bossBotId: BotId.make(record.data.bossBotId) } : {}),
        specialistBotIds: record.data.members
          .filter((member) => member.role === "specialist")
          .map((member) => member.botId),
        createdAt: record.updatedAt,
      });
      applied += 1;
      continue;
    }
    if (existing.name !== record.data.name) {
      commands.push({
        type: "group.rename",
        commandId: nextCommandId(),
        groupId: GroupId.make(record.id),
        name: record.data.name,
      });
    }
    const desired = new Map(record.data.members.map((member) => [member.botId, member.role]));
    const predicted = new Map(existing.members.map((member) => [member.botId, member.role]));
    if (record.data.bossBotId && existing.bossBotId !== record.data.bossBotId) {
      const unassignPreviousBoss = existing.bossBotId !== null && !desired.has(existing.bossBotId);
      commands.push({
        type: "group.boss.set",
        commandId: nextCommandId(),
        groupId: GroupId.make(record.id),
        bossBotId: record.data.bossBotId,
        unassignPreviousBoss,
      });
      if (existing.bossBotId !== null) {
        if (unassignPreviousBoss) predicted.delete(existing.bossBotId);
        else predicted.set(existing.bossBotId, "specialist");
      }
      predicted.set(record.data.bossBotId, "boss");
    }
    for (const [botId, role] of predicted) {
      if (role !== "boss" && desired.get(botId) !== role) {
        commands.push({
          type: "group.member.unassign",
          commandId: nextCommandId(),
          groupId: GroupId.make(record.id),
          botId,
        });
      }
    }
    for (const member of record.data.members) {
      if (member.role !== "boss" && predicted.get(member.botId) !== member.role) {
        commands.push({
          type: "group.member.assign",
          commandId: nextCommandId(),
          groupId: GroupId.make(record.id),
          botId: member.botId,
          role: member.role,
        });
      }
    }
    if (
      canonicalJson(
        portableRecords({ ...snapshot, groups: [existing] }, settings).find(
          (entry) => entry.type === "group",
        )?.data,
      ) !== canonicalJson(record.data)
    ) {
      applied += 1;
    }
  }

  const availableProjectIds = new Set(snapshot.projects.map((project) => project.id));
  for (const record of archive.records) {
    if (
      record.type !== "thread" ||
      conflictKeys.has(`thread:${record.id}`) ||
      !availableProjectIds.has(record.data.projectId)
    ) {
      continue;
    }
    const existing = threadsById.get(ThreadId.make(record.id));
    const existingArchived = existing !== undefined && existing.archivedAt !== null;
    const targetArchived = record.data.archivedAt !== null;
    const pinChanged = Boolean(record.data.pinnedAt) !== Boolean(existing?.pinnedAt);
    const unarchiveFirst = existingArchived && (pinChanged || !targetArchived);
    if (!existing) {
      commands.push({
        type: "thread.create",
        commandId: nextCommandId(),
        threadId: ThreadId.make(record.id),
        projectId: record.data.projectId,
        ...(record.data.botId !== undefined ? { botId: record.data.botId } : {}),
        ...(record.data.groupId !== undefined ? { groupId: record.data.groupId } : {}),
        title: record.data.title,
        modelSelection: record.data.modelSelection,
        runtimeMode: record.data.runtimeMode,
        interactionMode: record.data.interactionMode,
        branch: null,
        worktreePath: null,
        createdAt: record.data.createdAt,
      });
    } else {
      if (unarchiveFirst) {
        commands.push({
          type: "thread.unarchive",
          commandId: nextCommandId(),
          threadId: existing.id,
        });
      }
      if (
        existing.title !== record.data.title ||
        canonicalJson(existing.modelSelection) !== canonicalJson(record.data.modelSelection)
      ) {
        commands.push({
          type: "thread.meta.update",
          commandId: nextCommandId(),
          threadId: existing.id,
          title: record.data.title,
          modelSelection: record.data.modelSelection,
        });
      }
      if (existing.runtimeMode !== record.data.runtimeMode) {
        commands.push({
          type: "thread.runtime-mode.set",
          commandId: nextCommandId(),
          threadId: existing.id,
          runtimeMode: record.data.runtimeMode,
          createdAt: record.updatedAt,
        });
      }
      if (existing.interactionMode !== record.data.interactionMode) {
        commands.push({
          type: "thread.interaction-mode.set",
          commandId: nextCommandId(),
          threadId: existing.id,
          interactionMode: record.data.interactionMode,
          createdAt: record.updatedAt,
        });
      }
    }
    if (record.data.pinnedAt && !existing?.pinnedAt) {
      commands.push({
        type: "thread.pin",
        commandId: nextCommandId(),
        threadId: ThreadId.make(record.id),
      });
    } else if (!record.data.pinnedAt && existing?.pinnedAt) {
      commands.push({
        type: "thread.unpin",
        commandId: nextCommandId(),
        threadId: ThreadId.make(record.id),
      });
    }
    if (targetArchived && (!existingArchived || unarchiveFirst)) {
      commands.push({
        type: "thread.archive",
        commandId: nextCommandId(),
        threadId: ThreadId.make(record.id),
      });
    }
    const existingRecord = existing
      ? portableRecords({ ...snapshot, threads: [existing] }, settings).find(
          (entry) => entry.type === "thread",
        )
      : undefined;
    if (!existing || canonicalJson(existingRecord?.data) !== canonicalJson(record.data))
      applied += 1;
  }

  commands.push(...deferredBotArchiveCommands);
  return { commands, ...(settingsPatch ? { settingsPatch } : {}), applied, skipped };
}
