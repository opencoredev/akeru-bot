import type {
  AkeruMemoryDocumentTarget,
  AkeruMemoryRevision,
  AkeruMemoryThreadAccess,
} from "@t3tools/contracts";

import { BotMemoryError, type BotMemoryAccess, type BotMemoryStore } from "./BotMemory.ts";

export interface LegacyMemoryMigrationReport {
  readonly migrated: number;
  readonly archived: number;
  readonly alreadyComplete: boolean;
}

export function legacyMemoryMigrationKeys(access: AkeruMemoryThreadAccess): ReadonlyArray<string> {
  const botId = access.respondingBotId ?? access.botId;
  if (!botId) return [];
  return [
    "legacy-approved-private-v1",
    ...(access.groupId !== null && access.groupMemberBotIds.includes(botId)
      ? [`legacy-approved-group-${access.groupId}-v1`]
      : []),
  ];
}

const archiveEntry = (revision: AkeruMemoryRevision, reason: string) =>
  [
    `## ${revision.rootId}`,
    "",
    `- Scope: ${revision.partition.scope}`,
    `- Reason: ${reason}`,
    `- Updated: ${revision.updatedAt}`,
    "",
    revision.fact,
  ].join("\n");

async function migrateSet(input: {
  readonly store: BotMemoryStore;
  readonly access: BotMemoryAccess;
  readonly migrationKey: string;
  readonly revisions: ReadonlyArray<AkeruMemoryRevision>;
  readonly classify: (
    revision: AkeruMemoryRevision,
  ) => AkeruMemoryDocumentTarget | "archive" | "skip";
}): Promise<LegacyMemoryMigrationReport> {
  let migrated = 0;
  const archived: string[] = [];
  const ran = await input.store.runMigrationOnce(
    input.access.botId,
    input.migrationKey,
    async () => {
      for (const revision of input.revisions) {
        const target = input.classify(revision);
        if (target === "skip") continue;
        if (target === "archive") {
          archived.push(
            archiveEntry(revision, "This legacy scope has no injected Markdown target."),
          );
          continue;
        }
        try {
          const result = await input.store.mutate({
            ...input.access,
            target,
            operations: [{ action: "add", content: revision.fact }],
          });
          if (result.changed) migrated += 1;
        } catch (cause) {
          if (
            cause instanceof BotMemoryError &&
            (cause.code === "limit-exceeded" || cause.code === "unsafe-content")
          ) {
            archived.push(archiveEntry(revision, cause.message));
            continue;
          }
          throw cause;
        }
      }
      if (archived.length > 0) {
        await input.store.writeMigrationArchive(
          input.access.botId,
          input.migrationKey,
          [
            "# Legacy memory migration archive",
            "",
            "These approved facts were preserved but are not injected into prompts.",
            "",
            ...archived,
          ].join("\n\n"),
        );
      }
    },
  );
  return {
    migrated: ran ? migrated : 0,
    archived: ran ? archived.length : 0,
    alreadyComplete: !ran,
  };
}

export async function migrateLegacyBotMemory(input: {
  readonly store: BotMemoryStore;
  readonly access: AkeruMemoryThreadAccess;
  readonly revisions: ReadonlyArray<AkeruMemoryRevision>;
}): Promise<ReadonlyArray<LegacyMemoryMigrationReport>> {
  const botId = input.access.respondingBotId ?? input.access.botId;
  if (!botId) return [];
  const access: BotMemoryAccess = {
    botId,
    groupId: input.access.groupId,
    groupMemberBotIds: input.access.groupMemberBotIds,
  };
  const [privateMigrationKey, groupMigrationKey] = legacyMemoryMigrationKeys(input.access);
  const current = input.revisions.filter(
    (revision) => revision.approvalState === "approved" && revision.deletionState === "active",
  );
  const reports = [
    await migrateSet({
      store: input.store,
      access,
      migrationKey: privateMigrationKey!,
      revisions: current,
      classify: (revision) => {
        if (revision.partition.scope === "user" || revision.partition.scope === "bot-user") {
          return "user";
        }
        if (revision.partition.scope === "bot") {
          return String(revision.entityId) === String(botId) ? "memory" : "archive";
        }
        if (revision.partition.scope === "group") return "skip";
        return "archive";
      },
    }),
  ];
  if (groupMigrationKey) {
    reports.push(
      await migrateSet({
        store: input.store,
        access,
        migrationKey: groupMigrationKey,
        revisions: current,
        classify: (revision) =>
          revision.partition.scope !== "group"
            ? "skip"
            : String(revision.entityId) === String(access.groupId)
              ? "group"
              : "archive",
      }),
    );
  }
  return reports;
}
