import { AKERU_ARCHIVE_FORMAT, AKERU_ARCHIVE_VERSION, BALANCED_BOT_PERSONALITY_TONE, EventId, MessageId, isGroupBotMember, type PortabilityArchiveRecord, type OrchestrationReadModel, type ServerSettings } from "@akeru/contracts";

import { portabilityChecksum, canonicalJson, canonicalValue } from "./portabilityChecksums.ts";
import { safeText, safeServerSettings, safeMcpConfiguration, portableProjectData } from "./portabilitySafety.ts";

export const BUILTIN_MCP_PREFIX = "builtin-";

export const ARCHIVE_RECORD_TYPES = [
  "bot",
  "group",
  "mcp-server",
  "project",
  "server-settings",
  "thread",
] as const;

export const ARCHIVE_EXCLUSIONS = [
  "Access tokens, cookies, passwords, secret values, environment variables, and pairing credentials",
  "Absolute local paths, project scripts, attachments, image avatar files, Git refs, pull request links, and diff blobs",
  "Event identifiers, event sequences, command receipts, provider sessions, and opaque provider configuration",
  "Conversation attachments, raw approval payloads, provider request details, and deleted threads and projects",
] as const;

export type RecordCore = Omit<PortabilityArchiveRecord, "checksum">;

export function withChecksum(record: RecordCore): PortabilityArchiveRecord {
  return { ...record, checksum: portabilityChecksum(record) } as PortabilityArchiveRecord;
}

export function portableId(prefix: string, value: unknown): string {
  return `${prefix}-${portabilityChecksum(value).slice(0, 32)}`;
}

export const APPROVAL_ACTIVITY_KINDS = new Set([
  "approval.requested",
  "approval.resolved",
  "provider.approval.respond.failed",
]);

export function stringField(payload: unknown, key: string): string | undefined {
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
        ...(server.instructions ? { instructions: safeText(server.instructions) } : {}),
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
        imageProvider: bot.imageProvider,
        personalityTone: bot.personalityTone ?? BALANCED_BOT_PERSONALITY_TONE,
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
        members: group.members
          .filter(isGroupBotMember)
          .sort((left, right) => left.botId.localeCompare(right.botId)),
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
            const actor = stringField(activity.payload, "actor");
            const target = stringField(activity.payload, "target");
            const action = stringField(activity.payload, "action");
            const outcome = stringField(activity.payload, "outcome");
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
                ...(actor ? { actor } : {}),
                ...(target ? { target } : {}),
                ...(action ? { action } : {}),
                ...(outcome ? { outcome } : {}),
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
