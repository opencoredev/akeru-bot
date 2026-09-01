import * as NodeCrypto from "node:crypto";

import {
  AKERU_ARCHIVE_FORMAT,
  AKERU_ARCHIVE_VERSION,
  BotId,
  CommandId,
  DEFAULT_BOT_SANDBOX_BROWSER_SHARING,
  EventId,
  GroupId,
  MessageId,
  McpServerId,
  PortabilityArchive,
  ProjectId,
  ThreadId,
  type PortabilityArchiveRecord,
  type PortabilityImportItem,
  type PortabilityImportPreview,
  type PortabilityProjectFolderMap,
  type PortabilityProjectData,
  type PortabilitySafeServerSettings,
  type OrchestrationCommand,
  type OrchestrationReadModel,
  type ServerSettings,
  type ServerSettingsPatch,
} from "@t3tools/contracts";
import {
  isWindowsAbsolutePath,
  normalizeProjectPathForComparison,
  normalizeProjectPathForDispatch,
} from "@t3tools/shared/path";
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
  "Conversation attachments, raw approval payloads, provider request details, and deleted threads and projects",
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

function portableProjectData(
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

function settingsPatchFromPortable(settings: PortabilitySafeServerSettings): ServerSettingsPatch {
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

type RecordCore = Omit<PortabilityArchiveRecord, "checksum">;

function withChecksum(record: RecordCore): PortabilityArchiveRecord {
  return { ...record, checksum: portabilityChecksum(record) } as PortabilityArchiveRecord;
}

function portableId(prefix: string, value: unknown): string {
  return `${prefix}-${portabilityChecksum(value).slice(0, 32)}`;
}

const APPROVAL_ACTIVITY_KINDS = new Set([
  "approval.requested",
  "approval.resolved",
  "provider.approval.respond.failed",
]);

function stringField(payload: unknown, key: string): string | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  const value = (payload as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim().length > 0 ? safeText(value) : undefined;
}

export function portableRecords(
  snapshot: OrchestrationReadModel,
  settings: ServerSettings,
): PortabilityArchiveRecord[] {
  const mcpServerIds = new Set((snapshot.mcpServers ?? []).map((server) => server.id));
  const threadIds = new Set(snapshot.threads.map((thread) => thread.id));
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
    ...snapshot.projects
      .filter((project) => project.deletedAt === null)
      .map((project) => ({
        type: "project" as const,
        id: project.id,
        updatedAt: project.updatedAt,
        data: portableProjectData(project),
      })),
    ...snapshot.threads
      .filter((thread) => thread.deletedAt === null)
      .map((thread) => {
        const messages = [...thread.messages]
          .toSorted(
            (left, right) =>
              left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
          )
          .map((message, index) => {
            const data = {
              role: message.role,
              text: safeText(message.text),
              ...(message.respondingBotId !== undefined &&
              (message.respondingBotId === null ||
                snapshot.bots.some((bot) => bot.id === message.respondingBotId))
                ? { respondingBotId: message.respondingBotId }
                : {}),
              createdAt: message.createdAt,
              updatedAt: message.updatedAt,
            };
            return {
              id: MessageId.make(portableId("message", { threadId: thread.id, index, ...data })),
              ...data,
            };
          });
        const proposedPlans = [...thread.proposedPlans]
          .toSorted(
            (left, right) =>
              left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
          )
          .map((plan, index) => {
            const data = {
              planMarkdown: safeText(plan.planMarkdown),
              implementedAt: plan.implementedAt,
              implementationThreadId:
                plan.implementationThreadId !== null && threadIds.has(plan.implementationThreadId)
                  ? plan.implementationThreadId
                  : null,
              createdAt: plan.createdAt,
              updatedAt: plan.updatedAt,
            };
            return {
              id: portableId("plan", { threadId: thread.id, index, ...data }),
              ...data,
            };
          });
        const approvalHistory = thread.activities
          .flatMap((activity) => {
            const archivedKind = stringField(activity.payload, "originalKind");
            const originalKind = APPROVAL_ACTIVITY_KINDS.has(activity.kind)
              ? activity.kind
              : activity.kind === "approval.history" &&
                  archivedKind !== undefined &&
                  APPROVAL_ACTIVITY_KINDS.has(archivedKind)
                ? archivedKind
                : undefined;
            if (originalKind === undefined) return [];
            const requestId = stringField(activity.payload, "requestId");
            const requestKind = stringField(activity.payload, "requestKind");
            const requestType = stringField(activity.payload, "requestType");
            const decision = stringField(activity.payload, "decision");
            return [
              {
                originalKind: originalKind as
                  | "approval.requested"
                  | "approval.resolved"
                  | "provider.approval.respond.failed",
                summary: safeText(activity.summary),
                ...(requestId ? { requestId } : {}),
                ...(requestKind ? { requestKind } : {}),
                ...(requestType ? { requestType } : {}),
                ...(decision ? { decision } : {}),
                provider:
                  stringField(activity.payload, "provider") ?? thread.modelSelection.instanceId,
                createdAt: activity.createdAt,
              },
            ];
          })
          .toSorted(
            (left, right) =>
              left.createdAt.localeCompare(right.createdAt) ||
              canonicalJson(left).localeCompare(canonicalJson(right)),
          )
          .map((activity, index) => ({
            id: EventId.make(portableId("approval", { threadId: thread.id, index, ...activity })),
            ...activity,
          }));
        return {
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
            settledOverride:
              thread.settledOverride === "settled" || thread.settledAt !== null
                ? ("settled" as const)
                : thread.settledOverride === "active"
                  ? ("active" as const)
                  : null,
            settledAt:
              thread.settledOverride === "settled" || thread.settledAt !== null
                ? (thread.settledAt ?? thread.updatedAt)
                : null,
            snoozedUntil: thread.snoozedUntil && thread.snoozedAt ? thread.snoozedUntil : null,
            snoozedAt: thread.snoozedUntil && thread.snoozedAt ? thread.snoozedAt : null,
            pinnedAt: thread.pinnedAt ?? null,
            pinOrderKey: thread.pinOrderKey ?? null,
            messages,
            proposedPlans,
            approvalHistory,
          },
        };
      }),
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
    for (const message of record.data.messages) {
      assertSafeImportedText(`Thread '${record.id}' message`, message.text);
    }
    for (const plan of record.data.proposedPlans) {
      assertSafeImportedText(`Thread '${record.id}' proposed plan`, plan.planMarkdown);
    }
    for (const approval of record.data.approvalHistory) {
      assertSafeImportedText(`Thread '${record.id}' approval summary`, approval.summary);
      assertSafeImportedText(`Thread '${record.id}' approval provider`, approval.provider);
      for (const value of [
        approval.requestId,
        approval.requestKind,
        approval.requestType,
        approval.decision,
      ]) {
        if (value !== undefined)
          assertSafeImportedText(`Thread '${record.id}' approval field`, value);
      }
    }
    if (
      (record.data.settledOverride === "settled") !== (record.data.settledAt !== null) ||
      (record.data.snoozedUntil === null) !== (record.data.snoozedAt === null)
    ) {
      throw new Error(`Thread '${record.id}' has inconsistent lifecycle timestamps.`);
    }
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
  const threadIds = new Set(
    archive.records.filter((record) => record.type === "thread").map((record) => record.id),
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
      const missingRespondingBot = record.data.messages.find(
        (message) => message.respondingBotId && !botIds.has(message.respondingBotId),
      )?.respondingBotId;
      if (missingRespondingBot) {
        throw new Error(
          `Thread '${record.id}' message references missing bot '${missingRespondingBot}'.`,
        );
      }
      const missingImplementationThread = record.data.proposedPlans.find(
        (plan) =>
          plan.implementationThreadId !== null && !threadIds.has(plan.implementationThreadId),
      )?.implementationThreadId;
      if (missingImplementationThread) {
        throw new Error(
          `Thread '${record.id}' plan references missing thread '${missingImplementationThread}'.`,
        );
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

type ProjectRestoreMatch =
  | { readonly kind: "matched"; readonly targetId: ProjectId }
  | { readonly kind: "created"; readonly targetId: ProjectId; readonly workspaceRoot: string }
  | { readonly kind: "conflict" }
  | { readonly kind: "unsupported"; readonly reason: string };

function normalizedIdentityPart(value: string | undefined): string | undefined {
  return value?.trim().toLocaleLowerCase("en-US");
}

function repositoriesMatch(
  source: PortabilityProjectData["repository"],
  target: PortabilityProjectData["repository"],
): boolean {
  if (!source || !target) return false;
  const sourceProvider = normalizedIdentityPart(source.provider);
  const targetProvider = normalizedIdentityPart(target.provider);
  if (sourceProvider !== targetProvider) return false;
  const sourceOwner = normalizedIdentityPart(source.owner);
  const targetOwner = normalizedIdentityPart(target.owner);
  const sourceName = normalizedIdentityPart(source.name);
  const targetName = normalizedIdentityPart(target.name);
  if (sourceOwner && targetOwner && sourceName && targetName) {
    return sourceOwner === targetOwner && sourceName === targetName;
  }
  const sourceDisplayName = normalizedIdentityPart(source.displayName);
  const targetDisplayName = normalizedIdentityPart(target.displayName);
  return sourceDisplayName !== undefined && sourceDisplayName === targetDisplayName;
}

function resolveExistingProjectRestoreMatches(
  archive: PortabilityArchive,
  snapshot: OrchestrationReadModel,
): Map<string, ProjectRestoreMatch> {
  const sourceProjects = archive.records.filter((record) => record.type === "project");
  const targets = snapshot.projects
    .filter((project) => project.deletedAt === null)
    .map((project) => ({ project, data: portableProjectData(project) }));
  const matches = new Map<string, ProjectRestoreMatch>();

  for (const source of sourceProjects) {
    const sameIdTarget = targets.find((target) => target.project.id === source.id);
    if (sameIdTarget) {
      matches.set(source.id, { kind: "matched", targetId: sameIdTarget.project.id });
      continue;
    }
    const repositoryCandidates = source.data.repository
      ? targets.filter((target) =>
          repositoriesMatch(source.data.repository, target.data.repository),
        )
      : [];
    if (repositoryCandidates.length === 1) {
      matches.set(source.id, {
        kind: "matched",
        targetId: repositoryCandidates[0]!.project.id,
      });
      continue;
    }
    if (repositoryCandidates.length > 1) {
      const workspaceCandidates = repositoryCandidates.filter(
        (target) => target.data.workspaceName === source.data.workspaceName,
      );
      if (workspaceCandidates.length === 1) {
        matches.set(source.id, {
          kind: "matched",
          targetId: workspaceCandidates[0]!.project.id,
        });
      } else {
        matches.set(source.id, {
          kind: "conflict",
        });
      }
      continue;
    }

    const workspaceCandidates = targets.filter(
      (target) =>
        target.data.workspaceName === source.data.workspaceName &&
        (source.data.repository === undefined || target.data.repository === undefined),
    );
    if (workspaceCandidates.length === 1) {
      matches.set(source.id, {
        kind: "matched",
        targetId: workspaceCandidates[0]!.project.id,
      });
    } else if (workspaceCandidates.length > 1) {
      matches.set(source.id, {
        kind: "conflict",
      });
    } else {
      matches.set(source.id, {
        kind: "unsupported",
        reason: "No existing target project matches this repository or workspace name.",
      });
    }
  }

  const sourceIdsByTarget = new Map<string, string[]>();
  for (const [sourceId, match] of matches) {
    if (match.kind !== "matched") continue;
    const sourceIds = sourceIdsByTarget.get(match.targetId) ?? [];
    sourceIds.push(sourceId);
    sourceIdsByTarget.set(match.targetId, sourceIds);
  }
  for (const [targetId, sourceIds] of sourceIdsByTarget) {
    if (sourceIds.length < 2) continue;
    const exactId = sourceIds.find((sourceId) => sourceId === targetId);
    for (const sourceId of sourceIds) {
      if (sourceId === exactId) continue;
      matches.set(sourceId, {
        kind: "conflict",
      });
    }
  }

  return matches;
}

export function normalizePortabilityProjectFolders(
  archive: PortabilityArchive,
  snapshot: OrchestrationReadModel,
  projectFolders: PortabilityProjectFolderMap = {},
): PortabilityProjectFolderMap {
  const sourceProjects = new Map(
    archive.records.flatMap((record) =>
      record.type === "project" ? [[record.id, record] as const] : [],
    ),
  );
  const existingMatches = resolveExistingProjectRestoreMatches(archive, snapshot);
  const activeWorkspaceRoots = new Set(
    snapshot.projects
      .filter((project) => project.deletedAt === null)
      .map((project) => normalizeProjectPathForComparison(project.workspaceRoot)),
  );
  const targetWorkspaceRoots = new Map<string, string>();
  const normalized: Record<string, string> = {};

  for (const [projectId, destination] of Object.entries(projectFolders)) {
    if (!sourceProjects.has(projectId)) {
      throw new Error(`Project folder map references unknown project '${projectId}'.`);
    }
    if (existingMatches.get(projectId)?.kind !== "unsupported") {
      throw new Error(`Project '${projectId}' already has a target project.`);
    }
    if (!destination.startsWith("/") && !isWindowsAbsolutePath(destination)) {
      throw new Error(`Project '${projectId}' destination must be an absolute path.`);
    }
    const workspaceRoot = normalizeProjectPathForDispatch(destination);
    if (workspaceRoot === "/" || /^[A-Za-z]:[\\/]$/.test(workspaceRoot)) {
      throw new Error(`Project '${projectId}' destination cannot be a filesystem root.`);
    }
    const comparisonRoot = normalizeProjectPathForComparison(workspaceRoot);
    if (activeWorkspaceRoots.has(comparisonRoot)) {
      throw new Error(`Project '${projectId}' destination already belongs to an active project.`);
    }
    const otherProjectId = targetWorkspaceRoots.get(comparisonRoot);
    if (otherProjectId) {
      throw new Error(
        `Projects '${otherProjectId}' and '${projectId}' cannot use the same destination.`,
      );
    }
    targetWorkspaceRoots.set(comparisonRoot, projectId);
    normalized[projectId] = workspaceRoot;
  }

  return normalized as PortabilityProjectFolderMap;
}

function resolveProjectRestoreMatches(
  archive: PortabilityArchive,
  snapshot: OrchestrationReadModel,
  projectFolders: PortabilityProjectFolderMap = {},
): Map<string, ProjectRestoreMatch> {
  const matches = resolveExistingProjectRestoreMatches(archive, snapshot);
  const normalizedProjectFolders = normalizePortabilityProjectFolders(
    archive,
    snapshot,
    projectFolders,
  );
  for (const [sourceId, workspaceRoot] of Object.entries(normalizedProjectFolders)) {
    let targetId = ProjectId.make(sourceId);
    let collision = 0;
    while (snapshot.projects.some((project) => project.id === targetId)) {
      targetId = ProjectId.make(portableId("project", { sourceId, workspaceRoot, collision }));
      collision += 1;
    }
    matches.set(sourceId, {
      kind: "created",
      targetId,
      workspaceRoot,
    });
  }
  return matches;
}

function mutableProjectData(data: PortabilityProjectData) {
  return {
    title: data.title,
    defaultModelSelection: data.defaultModelSelection,
    defaultThreadEnvMode: data.defaultThreadEnvMode ?? null,
  };
}

function portableSettingsWithArchiveDefaults(
  settings: PortabilitySafeServerSettings,
): PortabilitySafeServerSettings {
  return {
    ...settings,
    botSandboxBrowserSharing:
      settings.botSandboxBrowserSharing ?? DEFAULT_BOT_SANDBOX_BROWSER_SHARING,
  };
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
  projectFolders: PortabilityProjectFolderMap = {},
): boolean {
  return (
    snapshot.snapshotSequence === preview.snapshotSequence &&
    portabilityChecksum({
      state: portabilityStateChecksum(snapshot, settings, availableProviderIds),
      projectFolders: Object.fromEntries(
        Object.entries(projectFolders)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([projectId, destination]) => [
            projectId,
            normalizeProjectPathForDispatch(destination),
          ]),
      ),
    }) === preview.stateChecksum
  );
}

export function previewPortabilityImport(
  archive: PortabilityArchive,
  snapshot: OrchestrationReadModel,
  settings: ServerSettings,
  availableProviderIds: ReadonlySet<string>,
  projectFolders: PortabilityProjectFolderMap = {},
): PortabilityImportPreview {
  const current = new Map(
    portableRecords(snapshot, settings).map((record) => [`${record.type}:${record.id}`, record]),
  );
  const normalizedProjectFolders = normalizePortabilityProjectFolders(
    archive,
    snapshot,
    projectFolders,
  );
  const existingProjectMatches = resolveExistingProjectRestoreMatches(archive, snapshot);
  const projectMatches = resolveProjectRestoreMatches(archive, snapshot, normalizedProjectFolders);
  const additions: PortabilityImportItem[] = [];
  const changes: PortabilityImportItem[] = [];
  const conflicts: PortabilityImportItem[] = [];
  const deletedThreadIds = new Set<string>(
    snapshot.threads.filter((thread) => thread.deletedAt !== null).map((thread) => thread.id),
  );
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
            : record.type === "project" && record.data.defaultModelSelection
              ? [record.data.defaultModelSelection.instanceId]
              : record.type === "server-settings"
                ? [
                    record.data.textGenerationModelSelection.instanceId,
                    ...(record.data.sourceControlWriterModelSelection
                      ? [record.data.sourceControlWriterModelSelection.instanceId]
                      : []),
                  ]
                : []
        ).filter((provider) => !availableProviderIds.has(provider)),
      ),
    ),
  ].sort();
  const missingProviderIds = new Set(missingProviders);
  const uncreatableProjectIds = new Set(
    archive.records.flatMap((record) =>
      record.type === "project" &&
      record.data.defaultModelSelection !== null &&
      missingProviderIds.has(record.data.defaultModelSelection.instanceId)
        ? [record.id]
        : [],
    ),
  );
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
  for (const record of archive.records) {
    const projectMatch =
      record.type === "project"
        ? projectMatches.get(record.id)
        : record.type === "thread"
          ? projectMatches.get(record.data.projectId)
          : undefined;
    if (projectMatch?.kind === "unsupported") {
      continue;
    }
    if (projectMatch?.kind === "conflict") {
      conflicts.push(item(record));
      continue;
    }
    if (
      (record.type === "bot" && unavailableBotIds.has(record.id)) ||
      (record.type === "server-settings" &&
        (missingProviderIds.has(record.data.textGenerationModelSelection.instanceId) ||
          (record.data.sourceControlWriterModelSelection !== null &&
            missingProviderIds.has(record.data.sourceControlWriterModelSelection.instanceId)))) ||
      (record.type === "project" &&
        record.data.defaultModelSelection !== null &&
        missingProviderIds.has(record.data.defaultModelSelection.instanceId)) ||
      (record.type === "group" && unavailableGroupIds.has(record.id)) ||
      (record.type === "thread" &&
        (deletedThreadIds.has(record.id) ||
          (projectMatch?.kind === "created" && uncreatableProjectIds.has(record.data.projectId)) ||
          missingProviderIds.has(record.data.modelSelection.instanceId) ||
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
    const existingKey =
      record.type === "project" &&
      (projectMatch?.kind === "matched" || projectMatch?.kind === "created")
        ? `project:${projectMatch.targetId}`
        : `${record.type}:${record.id}`;
    const existing = current.get(existingKey);
    const importedData =
      record.type === "thread" &&
      (projectMatch?.kind === "matched" || projectMatch?.kind === "created")
        ? { ...record.data, projectId: projectMatch.targetId }
        : record.type === "server-settings"
          ? portableSettingsWithArchiveDefaults(record.data)
          : record.data;
    if (!existing) additions.push(item(record));
    else if (
      record.type === "project" &&
      existing.type === "project" &&
      canonicalJson(mutableProjectData(existing.data)) ===
        canonicalJson(mutableProjectData(record.data))
    ) {
      continue;
    } else if (canonicalJson(existing.data) === canonicalJson(importedData)) {
      if (record.type === "mcp-server" && enabledMcpServerIds.has(McpServerId.make(record.id))) {
        changes.push(item(record));
      }
      continue;
    } else if (
      record.type === "thread" &&
      existing.type === "thread" &&
      (existing.data.projectId !==
        (projectMatch?.kind === "matched" || projectMatch?.kind === "created"
          ? projectMatch.targetId
          : record.data.projectId) ||
        existing.data.botId !== record.data.botId ||
        existing.data.groupId !== record.data.groupId ||
        ((existing.data.messages.length > 0 ||
          existing.data.proposedPlans.length > 0 ||
          existing.data.approvalHistory.length > 0) &&
          canonicalJson({
            messages: existing.data.messages,
            proposedPlans: existing.data.proposedPlans,
            approvalHistory: existing.data.approvalHistory,
          }) !==
            canonicalJson({
              messages: record.data.messages,
              proposedPlans: record.data.proposedPlans,
              approvalHistory: record.data.approvalHistory,
            })))
    ) {
      conflicts.push(item(record));
    } else if (existing.updatedAt > record.updatedAt) {
      conflicts.push(item(record));
    } else changes.push(item(record));
  }
  return {
    snapshotSequence: snapshot.snapshotSequence,
    stateChecksum: portabilityChecksum({
      state: portabilityStateChecksum(snapshot, settings, availableProviderIds),
      projectFolders: normalizedProjectFolders,
    }),
    additions,
    changes,
    conflicts,
    missingProviders,
    skippedSecrets: [
      "Provider sign-ins and private provider settings",
      "MCP server credentials and environment variables",
      "Device-specific paths, image files, Git state, and internal event identifiers",
    ],
    projectFolders: archive.records.flatMap((record) =>
      record.type === "project" && existingProjectMatches.get(record.id)?.kind === "unsupported"
        ? [
            {
              projectId: ProjectId.make(record.id),
              title: record.data.title,
              workspaceName: record.data.workspaceName,
              destination: normalizedProjectFolders[ProjectId.make(record.id)] ?? null,
            },
          ]
        : [],
    ),
    unsupported: [],
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

function itemForCommand(
  command: OrchestrationCommand,
  records: readonly PortabilityArchiveRecord[],
  projectSourceIdByTarget: ReadonlyMap<string, string>,
): PortabilityImportItem {
  const key = (() => {
    switch (command.type) {
      case "project.create":
      case "project.meta.update":
      case "project.delete":
        return `project:${projectSourceIdByTarget.get(command.projectId) ?? command.projectId}`;
      case "bot.create":
      case "bot.update":
      case "bot.archive":
      case "bot.restore":
        return `bot:${command.botId}`;
      case "group.create":
      case "group.rename":
      case "group.delete":
      case "group.member.assign":
      case "group.member.unassign":
      case "group.boss.set":
        return `group:${command.groupId}`;
      case "mcp-server.create":
      case "mcp-server.update":
      case "mcp-server.delete":
      case "mcp-server.enable":
      case "mcp-server.disable":
        return `mcp-server:${command.mcpServerId}`;
      default:
        return `thread:${command.threadId}`;
    }
  })();
  const record = records.find((entry) => `${entry.type}:${entry.id}` === key);
  if (!record) throw new Error(`Restore command '${command.type}' has no archive record.`);
  return item(record);
}

export interface PortabilityApplyOutcome {
  readonly item: PortabilityImportItem;
  readonly succeeded: boolean;
  readonly message?: string;
}

export function summarizePortabilityApply(
  outcomes: readonly PortabilityApplyOutcome[],
  skipped: number,
) {
  const byRecord = new Map<
    string,
    { item: PortabilityImportItem; succeeded: number; messages: string[] }
  >();
  for (const outcome of outcomes) {
    const key = `${outcome.item.recordType}:${outcome.item.id}`;
    const state = byRecord.get(key) ?? { item: outcome.item, succeeded: 0, messages: [] };
    if (outcome.succeeded) state.succeeded += 1;
    else state.messages.push(outcome.message ?? "Restore operation failed.");
    byRecord.set(key, state);
  }
  const failures = [...byRecord.values()]
    .filter((state) => state.messages.length > 0)
    .map((state) => ({
      ...state.item,
      partial: state.succeeded > 0,
      message: state.messages.join(" "),
    }));
  return {
    applied: [...byRecord.values()].filter((state) => state.messages.length === 0).length,
    skipped,
    failed: failures.filter((failure) => !failure.partial).length,
    partial: failures.filter((failure) => failure.partial).length,
    failures,
  };
}

export function commandsForPortabilityImport(
  archive: PortabilityArchive,
  snapshot: OrchestrationReadModel,
  settings: ServerSettings,
  availableProviderIds: ReadonlySet<string>,
  projectFolders: PortabilityProjectFolderMap = {},
): {
  commands: OrchestrationCommand[];
  commandItems: PortabilityImportItem[];
  settingsPatch?: ServerSettingsPatch;
  settingsItem?: PortabilityImportItem;
  applied: number;
  skipped: number;
} {
  const preview = previewPortabilityImport(
    archive,
    snapshot,
    settings,
    availableProviderIds,
    projectFolders,
  );
  const projectMatches = resolveProjectRestoreMatches(archive, snapshot, projectFolders);
  const projectSourceIdByTarget = new Map(
    [...projectMatches.entries()].flatMap(([sourceId, match]) =>
      match.kind === "matched" || match.kind === "created"
        ? [[match.targetId, sourceId] as const]
        : [],
    ),
  );
  const conflictKeys = new Set(preview.conflicts.map((entry) => `${entry.recordType}:${entry.id}`));
  const mcpById = new Map((snapshot.mcpServers ?? []).map((server) => [server.id, server]));
  const projectsById = new Map(snapshot.projects.map((project) => [project.id, project]));
  const botsById = new Map(snapshot.bots.map((bot) => [bot.id, bot]));
  const groupsById = new Map(snapshot.groups.map((group) => [group.id, group]));
  const threadsById = new Map(snapshot.threads.map((thread) => [thread.id, thread]));
  const currentRecords = new Map(
    portableRecords(snapshot, settings).map((record) => [`${record.type}:${record.id}`, record]),
  );
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
  const unmappedProjectRecordCount = archive.records.filter((record) => {
    const match =
      record.type === "project"
        ? projectMatches.get(record.id)
        : record.type === "thread"
          ? projectMatches.get(record.data.projectId)
          : undefined;
    return match?.kind === "unsupported";
  }).length;
  let skipped =
    preview.conflicts.length +
    preview.unsupported.reduce((total, entry) => total + entry.count, 0) +
    unmappedProjectRecordCount;

  for (const record of archive.records) {
    if (conflictKeys.has(`${record.type}:${record.id}`)) continue;
    if (record.type === "server-settings") {
      if (
        canonicalJson(safeServerSettings(settings)) !==
        canonicalJson(portableSettingsWithArchiveDefaults(record.data))
      ) {
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
    if (record.type !== "project" || conflictKeys.has(`project:${record.id}`)) continue;
    const match = projectMatches.get(record.id);
    if (match?.kind === "created") {
      commands.push({
        type: "project.create",
        commandId: nextCommandId(),
        projectId: match.targetId,
        title: record.data.title,
        workspaceRoot: match.workspaceRoot,
        defaultModelSelection: record.data.defaultModelSelection,
        createdAt: record.updatedAt,
      });
      if (record.data.defaultThreadEnvMode) {
        commands.push({
          type: "project.meta.update",
          commandId: nextCommandId(),
          projectId: match.targetId,
          defaultThreadEnvMode: record.data.defaultThreadEnvMode,
        });
      }
      applied += 1;
      continue;
    }
    if (match?.kind !== "matched") continue;
    const existing = projectsById.get(match.targetId);
    if (!existing) continue;
    const defaultThreadEnvMode = record.data.defaultThreadEnvMode ?? null;
    if (
      existing.title !== record.data.title ||
      canonicalJson(existing.defaultModelSelection) !==
        canonicalJson(record.data.defaultModelSelection) ||
      (existing.defaultThreadEnvMode ?? null) !== defaultThreadEnvMode
    ) {
      commands.push({
        type: "project.meta.update",
        commandId: nextCommandId(),
        projectId: existing.id,
        title: record.data.title,
        defaultModelSelection: record.data.defaultModelSelection,
        defaultThreadEnvMode,
      });
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
      canonicalJson(currentRecords.get(`bot:${record.id}`)?.data) !== canonicalJson(record.data);
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
      canonicalJson(currentRecords.get(`group:${record.id}`)?.data) !== canonicalJson(record.data)
    ) {
      applied += 1;
    }
  }

  for (const record of archive.records) {
    const projectMatch =
      record.type === "thread" ? projectMatches.get(record.data.projectId) : undefined;
    if (
      record.type !== "thread" ||
      conflictKeys.has(`thread:${record.id}`) ||
      (projectMatch?.kind !== "matched" && projectMatch?.kind !== "created")
    ) {
      continue;
    }
    const existing = threadsById.get(ThreadId.make(record.id));
    const existingRecord = existing ? currentRecords.get(`thread:${record.id}`) : undefined;
    if (!existing) {
      commands.push({
        type: "thread.create",
        commandId: nextCommandId(),
        threadId: ThreadId.make(record.id),
        projectId: projectMatch.targetId,
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
    const historyData = {
      messages: record.data.messages,
      proposedPlans: record.data.proposedPlans,
      approvalHistory: record.data.approvalHistory,
      settledOverride: record.data.settledOverride,
      settledAt: record.data.settledAt,
      snoozedUntil: record.data.snoozedUntil,
      snoozedAt: record.data.snoozedAt,
      pinnedAt: record.data.pinnedAt ?? null,
      pinOrderKey: record.data.pinOrderKey ?? null,
      archivedAt: record.data.archivedAt,
    };
    const existingHistoryData =
      existingRecord?.type === "thread"
        ? {
            messages: existingRecord.data.messages,
            proposedPlans: existingRecord.data.proposedPlans,
            approvalHistory: existingRecord.data.approvalHistory,
            settledOverride: existingRecord.data.settledOverride,
            settledAt: existingRecord.data.settledAt,
            snoozedUntil: existingRecord.data.snoozedUntil,
            snoozedAt: existingRecord.data.snoozedAt,
            pinnedAt: existingRecord.data.pinnedAt ?? null,
            pinOrderKey: existingRecord.data.pinOrderKey ?? null,
            archivedAt: existingRecord.data.archivedAt,
          }
        : undefined;
    const hasHistoryState =
      record.data.messages.length > 0 ||
      record.data.proposedPlans.length > 0 ||
      record.data.approvalHistory.length > 0 ||
      record.data.settledOverride !== null ||
      record.data.snoozedUntil !== null ||
      record.data.pinnedAt != null ||
      record.data.archivedAt !== null;
    const restoreConversation =
      existing === undefined ||
      (existing.messages.length === 0 &&
        existing.proposedPlans.length === 0 &&
        existing.activities.every((activity) => activity.kind !== "approval.history"));
    if (
      (existingHistoryData === undefined && hasHistoryState) ||
      (existingHistoryData !== undefined &&
        canonicalJson(existingHistoryData) !== canonicalJson(historyData))
    ) {
      commands.push({
        type: "thread.history.restore",
        commandId: nextCommandId(),
        threadId: ThreadId.make(record.id),
        messages: restoreConversation
          ? record.data.messages.map((message) => ({
              ...message,
              turnId: null,
              streaming: false,
            }))
          : [],
        proposedPlans: restoreConversation
          ? record.data.proposedPlans.map((plan) => ({
              ...plan,
              turnId: null,
            }))
          : [],
        activities: restoreConversation
          ? record.data.approvalHistory.map((approval) => ({
              id: approval.id,
              tone: "approval" as const,
              kind: "approval.history",
              summary: approval.summary,
              payload: {
                originalKind: approval.originalKind,
                ...(approval.requestId ? { requestId: approval.requestId } : {}),
                ...(approval.requestKind ? { requestKind: approval.requestKind } : {}),
                ...(approval.requestType ? { requestType: approval.requestType } : {}),
                ...(approval.decision ? { decision: approval.decision } : {}),
                provider: approval.provider,
              },
              turnId: null,
              createdAt: approval.createdAt,
            }))
          : [],
        settledOverride: record.data.settledOverride,
        settledAt: record.data.settledAt,
        snoozedUntil: record.data.snoozedUntil,
        snoozedAt: record.data.snoozedAt,
        pinnedAt: record.data.pinnedAt ?? null,
        pinOrderKey: record.data.pinOrderKey ?? null,
        archivedAt: record.data.archivedAt,
        updatedAt: record.updatedAt,
      });
    }
    const importedData = { ...record.data, projectId: projectMatch.targetId };
    if (!existing || canonicalJson(existingRecord?.data) !== canonicalJson(importedData))
      applied += 1;
  }

  commands.push(...deferredBotArchiveCommands);
  return {
    commands,
    commandItems: commands.map((command) =>
      itemForCommand(command, archive.records, projectSourceIdByTarget),
    ),
    ...(settingsPatch
      ? {
          settingsPatch,
          settingsItem: item(archive.records.find((record) => record.type === "server-settings")!),
        }
      : {}),
    applied,
    skipped,
  };
}
