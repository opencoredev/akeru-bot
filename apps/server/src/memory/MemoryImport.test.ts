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
  type AkeruMemoryArchive,
  type AkeruMemoryRevision,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { exportAkeruMemory } from "./MemoryExport.ts";
import { previewAkeruMemoryImport } from "./MemoryImport.ts";
import type { EntityMemoryRepositoryShape } from "./Services/EntityMemoryRepository.ts";

const access = {
  tenantId: AkeruMemoryTenantId.make("local"),
  userId: AkeruMemoryUserId.make("owner"),
  threadId: ThreadId.make("thread-import"),
  projectId: ProjectId.make("project-import"),
  workspaceRoot: "/workspace/import",
  botId: BotId.make("bot-import"),
  groupId: null,
  respondingBotId: null,
  groupMemberBotIds: [],
} as const;

const revision = {
  id: AkeruMemoryId.make("revision-import"),
  rootId: AkeruMemoryRootId.make("root-import"),
  revision: 1,
  partition: {
    tenantId: access.tenantId,
    scope: "bot" as const,
    partitionId: AkeruMemoryPartitionId.make(access.botId),
  },
  entityKind: "bot" as const,
  entityId: AkeruMemoryEntityId.make(access.botId),
  kind: "fact" as const,
  value: {},
  fact: "The imported bot uses Bun.",
  sourceThreadId: access.threadId,
  sourceMessageId: null,
  authorBotId: access.botId,
  initiatingUserId: access.userId,
  createdAt: "2026-08-30T20:00:00.000Z",
  confirmedAt: "2026-08-30T20:00:00.000Z",
  updatedAt: "2026-08-30T20:00:00.000Z",
  confidence: 1,
  approvalState: "approved" as const,
  supersedesId: null,
  supersededById: null,
  visibility: "private" as const,
  deletionState: "active" as const,
  pinned: false,
  sensitive: false,
  affectedBotIds: [access.botId],
} satisfies AkeruMemoryRevision;

const archiveWithRevisions = (
  revisions: ReadonlyArray<AkeruMemoryRevision>,
  target: "bot" | "all" = "bot",
  complete = true,
) => {
  const repository = {
    listByPartitions: () => Effect.succeed(revisions),
  } as unknown as EntityMemoryRepositoryShape;
  return exportAkeruMemory({
    repository,
    access,
    target,
    complete,
    createdAt: "2026-08-30T21:00:00.000Z",
    conversations: [],
  });
};

const archive = (target: "bot" | "all", complete: boolean) =>
  archiveWithRevisions([revision], target, complete);

const previewRepository = {
  previewImport: () =>
    Effect.succeed({
      previewHash: "a".repeat(64),
      items: [],
    }),
} as unknown as EntityMemoryRepositoryShape;

it.effect("rejects readable V1 archives for import", () =>
  Effect.gen(function* () {
    const v1 = {
      schemaVersion: 1,
      threadId: access.threadId,
      complete: true,
      createdAt: "2026-08-30T21:00:00.000Z",
      files: [],
      manifestSha256: "a".repeat(64),
    } satisfies AkeruMemoryArchive;
    const failure = yield* previewAkeruMemoryImport({
      repository: previewRepository,
      access,
      target: "thread",
      archive: v1,
    }).pipe(Effect.flip);
    assert.match(failure.message, /Version 1/);
  }),
);

it.effect("rejects current-state and all-authority archives", () =>
  Effect.gen(function* () {
    const currentOnly = yield* archive("bot", false);
    const incomplete = yield* previewAkeruMemoryImport({
      repository: previewRepository,
      access,
      target: "bot",
      archive: currentOnly,
    }).pipe(Effect.flip);
    assert.match(incomplete.message, /complete revision chain/);

    const all = yield* archive("all", true);
    const allFailure = yield* previewAkeruMemoryImport({
      repository: previewRepository,
      access,
      target: "all",
      archive: all,
    }).pipe(Effect.flip);
    assert.match(allFailure.message, /authority domains/);
  }),
);

it.effect("rejects target, checksum, and readable-file mismatches", () =>
  Effect.gen(function* () {
    const valid = yield* archive("bot", true);
    const targetFailure = yield* previewAkeruMemoryImport({
      repository: previewRepository,
      access,
      target: "project",
      archive: valid,
    }).pipe(Effect.flip);
    assert.match(targetFailure.message, /does not match/);
    if (valid.schemaVersion !== 2) return assert.fail("Expected a V2 archive.");

    const checksumFailure = yield* previewAkeruMemoryImport({
      repository: previewRepository,
      access,
      target: "bot",
      archive: {
        ...valid,
        files: valid.files.map((file) => ({ ...file, content: `${file.content}tampered` })),
      },
    }).pipe(Effect.flip);
    assert.match(checksumFailure.message, /checksum failed/);

    const fileMismatch = {
      ...valid,
      files: [],
    } satisfies AkeruMemoryArchive;
    const mismatch = yield* previewAkeruMemoryImport({
      repository: previewRepository,
      access,
      target: "bot",
      archive: fileMismatch,
    }).pipe(Effect.flip);
    assert.match(mismatch.message, /manifest is invalid|do not match/);
  }),
);

it.effect("rejects unapproved and resurrected archive revisions", () =>
  Effect.gen(function* () {
    const unapproved = yield* archiveWithRevisions([{ ...revision, approvalState: "pending" }]);
    const unapprovedFailure = yield* previewAkeruMemoryImport({
      repository: previewRepository,
      access,
      target: "bot",
      archive: unapproved,
    }).pipe(Effect.flip);
    assert.match(unapprovedFailure.message, /must already be approved/);

    const tombstoneId = AkeruMemoryId.make("revision-import-tombstone");
    const activeId = AkeruMemoryId.make("revision-import-resurrected");
    const tombstone = {
      ...revision,
      id: tombstoneId,
      supersededById: activeId,
      deletionState: "tombstoned" as const,
    };
    const resurrected = {
      ...revision,
      id: activeId,
      revision: 2,
      supersedesId: tombstoneId,
      supersededById: null,
      updatedAt: "2026-08-30T20:01:00.000Z",
    };
    const resurrectedArchive = yield* archiveWithRevisions([tombstone, resurrected]);
    const resurrectedFailure = yield* previewAkeruMemoryImport({
      repository: previewRepository,
      access,
      target: "bot",
      archive: resurrectedArchive,
    }).pipe(Effect.flip);
    assert.match(resurrectedFailure.message, /terminal archive revision/);
  }),
);
