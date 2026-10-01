import * as Match from "effect/Match";
import {
  DEFAULT_BOT_SANDBOX_BROWSER_SHARING,
  McpServerId,
  PortabilityArchive,
  ProjectId,
  type PortabilityArchiveRecord,
  type PortabilityImportItem,
  type PortabilityImportPreview,
  type PortabilityProjectFolderMap,
  type PortabilitySafeServerSettings,
  type OrchestrationReadModel,
  type ServerSettings,
} from "@akeru/contracts";
import { normalizeProjectPathForDispatch } from "@akeru/shared/path";

import { portabilityChecksum, canonicalJson } from "./portabilityChecksums.ts";
import { portableRecords } from "./portabilityArchive.ts";
import {
  normalizePortabilityProjectFolders,
  resolveExistingProjectRestoreMatches,
  resolveProjectRestoreMatches,
  mutableProjectData,
} from "./portabilityProjectRestore.ts";

export function item(record: PortabilityArchiveRecord): PortabilityImportItem {
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

export function portableSettingsWithArchiveDefaults(
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

      return record.data.bossBotId === null || hasUnavailableMember ? [record.id] : [];
    }),
  );

  for (const record of archive.records) {
    const projectMatch = Match.value(record).pipe(
      Match.when({ type: "project" }, (record) => projectMatches.get(record.id)),
      Match.when({ type: "thread" }, (record) => projectMatches.get(record.data.projectId)),
      Match.orElse((_record) => undefined),
    );

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
