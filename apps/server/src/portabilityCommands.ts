import * as Match from "effect/Match";
import * as NodeCrypto from "node:crypto";
import {
  BotId,
  BALANCED_BOT_PERSONALITY_TONE,
  CommandId,
  GroupId,
  McpServerId,
  PortabilityArchive,
  ThreadId,
  isGroupBotMember,
  type PortabilityArchiveRecord,
  type PortabilityImportItem,
  type PortabilityProjectFolderMap,
  type OrchestrationCommand,
  type OrchestrationReadModel,
  type ServerSettings,
  type ServerSettingsPatch,
} from "@akeru/contracts";

import {
  item,
  previewPortabilityImport,
  portableSettingsWithArchiveDefaults,
} from "./portabilityPreview.ts";
import { resolveProjectRestoreMatches } from "./portabilityProjectRestore.ts";
import { portableRecords } from "./portabilityArchive.ts";
import { canonicalJson } from "./portabilityChecksums.ts";
import {
  safeServerSettings,
  settingsPatchFromPortable,
  safeMcpConfiguration,
} from "./portabilitySafety.ts";

export function nextCommandId(): CommandId {
  return CommandId.make(`portability-${NodeCrypto.randomUUID()}`);
}

export function mcpCommand(
  type: "mcp-server.create" | "mcp-server.update",
  record: Extract<PortabilityArchiveRecord, { type: "mcp-server" }>,
): OrchestrationCommand {
  const config = record.data.configuration;

  const common = {
    commandId: nextCommandId(),
    mcpServerId: McpServerId.make(record.id),
    ...config,
  };

  return type === "mcp-server.create"
    ? { ...common, type, enabled: false, createdAt: record.updatedAt }
    : { ...common, type };
}

export function itemForCommand(
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
      case "bot.delete":
        return `bot:${command.botId}`;
      case "group.create":
      case "group.rename":
      case "group.delete":
      case "group.member.assign":
      case "group.member.unassign":
      case "group.person.assign":
      case "group.person.unassign":
      case "group.leave":
      case "group.boss.set":
        return `group:${command.groupId}`;
      case "mcp-server.create":
      case "mcp-server.update":
      case "mcp-server.instructions.set":
      case "mcp-server.delete":
      case "mcp-server.enable":
      case "mcp-server.disable":
        return `mcp-server:${command.mcpServerId}`;
      case "delegation.create":
      case "delegation.state.set":
        return `delegation:${command.delegation.delegationId}`;
      case "delegation.cancel":
      case "delegation.retry":
        return `delegation:${command.delegationId}`;
      case "routine.create-approved":
      case "routine.draft":
      case "routine.approve":
      case "routine.enable":
      case "routine.pause":
      case "routine.run":
      case "routine.run.scheduled":
      case "routine.run.start":
      case "routine.run.block":
      case "routine.run.fail":
      case "routine.run.complete":
      case "routine.run.cancel":
      case "routine.delete":
        return `routine:${command.routineId}`;
      case "routine.skill.assign":
      case "routine.skill.unassign":
        return `skill-assignment:${command.assignmentId}`;
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

  const failures = [...byRecord.values()].flatMap((state) =>
    state.messages.length > 0
      ? [
          {
            ...state.item,
            partial: state.succeeded > 0,
            message: state.messages.join(" "),
          },
        ]
      : [],
  );

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
): CommandsForPortabilityImportResult {
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
    const match = Match.value(record).pipe(
      Match.when({ type: "project" }, (record) => projectMatches.get(record.id)),
      Match.when({ type: "thread" }, (record) => projectMatches.get(record.data.projectId)),
      Match.orElse((_record) => undefined),
    );

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

    const instructionsChanged = (existing?.instructions ?? "") !== (record.data.instructions ?? "");

    if (instructionsChanged) {
      commands.push({
        type: "mcp-server.instructions.set",
        commandId: nextCommandId(),
        mcpServerId: McpServerId.make(record.id),
        instructions: record.data.instructions ?? "",
      });
    }

    if (!existing || configurationChanged || instructionsChanged || existing.enabled) {
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
      imageProvider: record.data.imageProvider,
      personalityTone: record.data.personalityTone ?? BALANCED_BOT_PERSONALITY_TONE,
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

    const predicted = new Map(
      existing.members.filter(isGroupBotMember).map((member) => [member.botId, member.role]),
    );

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
                ...(approval.actor ? { actor: approval.actor } : {}),
                ...(approval.target ? { target: approval.target } : {}),
                ...(approval.action ? { action: approval.action } : {}),
                ...(approval.outcome ? { outcome: approval.outcome } : {}),
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

type CommandsForPortabilityImportResult = {
  commands: OrchestrationCommand[];
  commandItems: PortabilityImportItem[];
  settingsPatch?: ServerSettingsPatch;
  settingsItem?: PortabilityImportItem;
  applied: number;
  skipped: number;
};
