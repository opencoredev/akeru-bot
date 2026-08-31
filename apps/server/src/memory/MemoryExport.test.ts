import { assert, it } from "@effect/vitest";
import {
  AkeruMemoryEntityId,
  AkeruMemoryId,
  AkeruMemoryPartitionId,
  AkeruMemoryRootId,
  AkeruMemoryTenantId,
  AkeruMemoryUserId,
  BotId,
  ProjectId,
  ThreadId,
  type AkeruMemoryRevision,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { exportAkeruMemory } from "./MemoryExport.ts";
import type { EntityMemoryRepositoryShape } from "./Services/EntityMemoryRepository.ts";

const access = {
  tenantId: AkeruMemoryTenantId.make("local"),
  userId: AkeruMemoryUserId.make("owner"),
  threadId: ThreadId.make("thread-export"),
  projectId: ProjectId.make("project-export"),
  workspaceRoot: "/workspace/export",
  botId: BotId.make("bot-export"),
  groupId: null,
  respondingBotId: null,
  groupMemberBotIds: [],
} as const;

const revision = (number: number, deletionState: "active" | "tombstoned") =>
  ({
    id: AkeruMemoryId.make(`revision-${number}`),
    rootId: AkeruMemoryRootId.make("root-export"),
    revision: number,
    partition: {
      tenantId: access.tenantId,
      scope: "bot-user" as const,
      partitionId: AkeruMemoryPartitionId.make("bot-export:owner"),
    },
    entityKind: "user" as const,
    entityId: AkeruMemoryEntityId.make("owner"),
    kind: "fact" as const,
    value: {},
    fact: number === 1 ? "The user prefers vim." : "The user removed this preference.",
    sourceThreadId: access.threadId,
    sourceMessageId: null,
    authorBotId: access.botId,
    initiatingUserId: access.userId,
    createdAt: "2026-08-30T20:00:00.000Z",
    confirmedAt: "2026-08-30T20:00:00.000Z",
    updatedAt: `2026-08-30T20:0${number}:00.000Z`,
    confidence: 1,
    approvalState: "approved" as const,
    supersedesId: number === 1 ? null : AkeruMemoryId.make("revision-1"),
    supersededById: number === 1 ? AkeruMemoryId.make("revision-2") : null,
    visibility: "private" as const,
    deletionState,
    pinned: false,
    sensitive: false,
    affectedBotIds: [access.botId],
  }) satisfies AkeruMemoryRevision;

it.effect("exports readable complete history with checksums and tombstones", () => {
  const current = revision(2, "tombstoned");
  const initial = revision(1, "active");
  const repository = {
    listByPartitions: () => Effect.succeed([initial, current]),
  } as unknown as EntityMemoryRepositoryShape;
  return Effect.gen(function* () {
    const archive = yield* exportAkeruMemory({
      repository,
      access,
      target: "bot",
      complete: true,
      createdAt: "2026-08-30T21:00:00.000Z",
      conversations: [],
    });

    assert.equal(archive.schemaVersion, 2);
    assert.equal(archive.files.length, 2);
    if (archive.schemaVersion !== 2) return assert.fail("Expected a V2 archive.");
    assert.equal(archive.target, "bot");
    assert.equal(archive.revisions.length, 2);
    assert.match(archive.manifestSha256, /^[a-f0-9]{64}$/);
    assert.include(archive.files[0]?.content ?? "", "The user prefers vim.");
    assert.include(archive.files[1]?.content ?? "", '"deletionState":"tombstoned"');
    assert.isTrue(archive.files.every((file) => file.sha256.length === 64));
  });
});
