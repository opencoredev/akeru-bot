import {
  AkeruMemoryEntityId,
  AkeruMemoryId,
  AkeruMemoryPartitionId,
  AkeruMemoryRootId,
  AkeruMemoryTenantId,
  AkeruMemoryUserId,
  BotId,
  GroupId,
  MessageId,
  ProjectId,
  ThreadId,
  type AkeruMemoryRevision,
} from "@akeru/contracts";
import * as Layer from "effect/Layer";
import { SqlitePersistenceMemory } from "../../../persistence/Layers/Sqlite.ts";
import { type EntityMemoryRepositoryShape } from "../../Services/EntityMemoryRepository.ts";
import { MemoryRevisionWriteLockLive } from "../../Services/MemoryRevisionWriteLock.ts";
import { EntityMemoryRepositoryLive } from "../EntityMemoryRepository.ts";

const repositoryLayer = Layer.mergeAll(
  EntityMemoryRepositoryLive.pipe(
    Layer.provide(MemoryRevisionWriteLockLive),
    Layer.provide(SqlitePersistenceMemory),
  ),
  SqlitePersistenceMemory,
);

const makeRevision = (
  id: string,
  partitionId: string,
  overrides: Partial<AkeruMemoryRevision> = {},
): AkeruMemoryRevision => {
  const authorBotId = BotId.make(partitionId.includes(":") ? partitionId.split(":")[0]! : "bot");
  return {
    id: AkeruMemoryId.make(id),
    rootId: AkeruMemoryRootId.make(id),
    revision: 1,
    partition: {
      tenantId: AkeruMemoryTenantId.make("tenant"),
      scope: "bot-user",
      partitionId: AkeruMemoryPartitionId.make(partitionId),
    },
    entityKind: "user",
    entityId: AkeruMemoryEntityId.make("user"),
    kind: "preference",
    value: { editor: "vim" },
    fact: `The user in ${partitionId} prefers vim.`,
    sourceThreadId: ThreadId.make(`thread-${authorBotId}`),
    sourceMessageId: MessageId.make("message"),
    authorBotId,
    initiatingUserId: AkeruMemoryUserId.make("user"),
    createdAt: "2026-08-30T21:00:00.000Z",
    confirmedAt: "2026-08-30T21:00:00.000Z",
    updatedAt: "2026-08-30T21:00:00.000Z",
    confidence: 0.9,
    approvalState: "approved",
    supersedesId: null,
    supersededById: null,
    visibility: "private",
    deletionState: "active",
    pinned: false,
    sensitive: false,
    affectedBotIds: [authorBotId],
    ...overrides,
  };
};

const privateAccess = (botId: string) =>
  ({
    tenantId: AkeruMemoryTenantId.make("tenant"),
    userId: AkeruMemoryUserId.make("user"),
    threadId: ThreadId.make(`thread-${botId}`),
    projectId: ProjectId.make("project"),
    workspaceRoot: "/workspace",
    legacyWorkspaceOwnerProjectId: ProjectId.make("project"),
    botId: BotId.make(botId),
    groupId: null,
    respondingBotId: null,
    groupMemberBotIds: [],
  }) as const;

const insert = (repository: EntityMemoryRepositoryShape, revision: AkeruMemoryRevision) =>
  repository.insert({
    access: privateAccess(revision.partition.partitionId.split(":")[0] ?? "bot"),
    revision,
  });

const botAccess = privateAccess("bot");

const sharedAccess = {
  ...privateAccess("bot"),
  groupId: GroupId.make("group"),
  respondingBotId: BotId.make("bot"),
  groupMemberBotIds: [BotId.make("bot")],
} as const;
export { repositoryLayer, makeRevision, privateAccess, insert, botAccess, sharedAccess };
